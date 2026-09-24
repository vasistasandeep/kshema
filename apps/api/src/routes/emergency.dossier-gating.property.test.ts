// Feature: kshema-safety-platform, Property 23: Emergency medical dossier
// access gating. For all Emergency_Medical_Dossiers and any (viewerRole,
// incidentStage, tokenValid, resolved) context, the dossier plaintext SHALL be
// readable if and only if the viewer is the Ephemeral_Responder_Portal holding
// a valid Emergency_Access_Token whose bound incident is at
// STAGE_4_HYPERLOCAL_DISPATCH; access SHALL be revoked immediately once the
// incident is resolved; and the dossier SHALL never be readable by an
// Admin_User or an ordinary Observer surface during normal operation.
/**
 * Property-based test for the Emergency_Medical_Dossier release gate exercised
 * through `GET /api/v1/emergency/:token` (task 13.3) and, negatively, through
 * the Admin / Observer surfaces.
 *
 * Validates: Requirements 33.2, 33.3, 33.4
 *
 * Uses the same hermetic fake-Prisma + `app.inject` harness style as the unit
 * tests in `emergency.test.ts` (helpers copied here so this property test is
 * self-contained and does not depend on that file's non-exported helpers). The
 * fake Prisma backs the token / incident / user / profile / dossier reads and
 * writes; the token verifier, break-glass dossier decryptor, and Observer
 * notifier are injected fakes. No live DB / Redis / JWT plugin / escrow key is
 * needed.
 *
 * The property draws arbitrary combinations of four independent facts, exactly
 * matching the design generator:
 *   - viewer      : 'ADMIN' | 'OBSERVER' | 'RESPONDER_PORTAL'
 *   - stage       : any IncidentStage
 *   - tokenValid  : boolean (a good signature + live row vs a bad signature)
 *   - resolved    : boolean (once resolved the token is invalidated → R33.4)
 *
 * and asserts the release law (R33.2/R33.3/R33.4):
 *   dossier plaintext is returned
 *     IFF viewer === RESPONDER_PORTAL
 *      AND tokenValid
 *      AND NOT resolved            (revoked immediately on resolution — R33.4)
 *      AND stage === STAGE_4_HYPERLOCAL_DISPATCH   (release gate — R33.3)
 *
 * The Admin and Observer surfaces (R33.2) are checked structurally: there is no
 * dossier-plaintext GET on any authenticated surface, so an attempted fetch
 * from those roles can never yield the clinical fields. Both the responder-
 * portal path AND the admin/observer paths are driven so the "iff" holds in
 * both directions.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import {
  hashEmergencyToken,
  EMERGENCY_TRIAGE_SCOPE,
  type EmergencyTokenClaims,
} from "../services/emergency-token.js";
import type {
  EmergencyRouteDeps,
  DecryptedDossierView,
} from "./emergency.js";

const NOW = 1_700_000_000_000;
const STAGE_4 = "STAGE_4_HYPERLOCAL_DISPATCH" as const;

const ALL_STAGES = [
  "STAGE_1_CONVERSATIONAL_WHATSAPP",
  "STAGE_2_GENTLE_DEVICE_CHIME",
  "STAGE_3_OBSERVER_SILENT_ALERT",
  "STAGE_4_HYPERLOCAL_DISPATCH",
] as const;

const VIEWERS = ["ADMIN", "OBSERVER", "RESPONDER_PORTAL"] as const;
type Viewer = (typeof VIEWERS)[number];

const CIRCLE_ID = "circle_1";
const ANCHOR_ID = "anchor_1";
const INCIDENT_ID = "incident_1";

// The decrypted-for-emergency clinical fields the dossier release would expose.
// Distinctive sentinel values so the property can assert none of them leak on a
// deny (R33.2/R33.4) and all appear on a legitimate release (R33.3).
const DECRYPTED: DecryptedDossierView = {
  bloodGroup: "O-negative-SENTINEL",
  allergies: ["penicillin-SENTINEL"],
  chronicConditions: ["hypertension-SENTINEL"],
  criticalMedications: ["amlodipine-SENTINEL"],
  attendingDoctorName: "Dr-Rao-SENTINEL",
  attendingDoctorPhone: "+919800000000",
  healthInsurancePolicy: "POL-SENTINEL",
};

// Every clinical secret that MUST never appear outside a legitimate release.
const CLINICAL_SECRETS = [
  DECRYPTED.bloodGroup!,
  ...DECRYPTED.allergies!,
  ...DECRYPTED.chronicConditions!,
  ...DECRYPTED.criticalMedications!,
  DECRYPTED.attendingDoctorName!,
  DECRYPTED.attendingDoctorPhone!,
  DECRYPTED.healthInsurancePolicy!,
];

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    OTP_SECRET: "test-otp-secret",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0",
    PORT: "0",
  });
}

// --------------------------------------------------------------------------
// Fake Prisma fixtures (trimmed copy of emergency.test.ts).
// --------------------------------------------------------------------------

interface TokenRow {
  id: string;
  incidentId: string;
  tokenHash: string;
  scope: string;
  expiresAt: Date;
  invalidatedAt: Date | null;
}

interface IncidentRow {
  id: string;
  circleId: string;
  anchorId: string;
  stage: string;
  status: string;
  auditTrail: unknown[];
  resolutionSource?: string | null;
}

interface UserRow {
  id: string;
  preferredName: string | null;
}

interface ProfileRow {
  anchorId: string;
  society: string | null;
  building: string | null;
  flat: string | null;
  doorAccess: string | null;
  primaryObserverPhone: string | null;
}

interface DossierRow {
  id: string;
  userId: string;
  encryptedPayload: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedEmergencyKey: Buffer;
  accessState: string;
}

interface Fixtures {
  tokens?: TokenRow[];
  incidents?: IncidentRow[];
  users?: UserRow[];
  profiles?: ProfileRow[];
  dossiers?: DossierRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const tokens = fixtures.tokens ?? [];
  const incidents = fixtures.incidents ?? [];
  const users = fixtures.users ?? [];
  const profiles = fixtures.profiles ?? [];
  const dossiers = fixtures.dossiers ?? [];

  const prisma = {
    emergencyAccessToken: {
      findUnique: vi.fn(async (args: { where: { tokenHash: string } }) => {
        return tokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = tokens.find((t) => t.id === args.where.id);
          if (!row) throw new Error("token not found");
          Object.assign(row, args.data);
          return { ...row };
        },
      ),
    },
    safetyIncident: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = incidents.find((i) => i.id === args.where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = incidents.find((i) => i.id === args.where.id);
          if (!row) throw new Error("incident not found");
          Object.assign(row, args.data);
          return { ...row };
        },
      ),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = users.find((u) => u.id === args.where.id);
        return row ? { ...row } : null;
      }),
    },
    hyperlocalContactProfile: {
      findUnique: vi.fn(async (args: { where: { anchorId: string } }) => {
        const row = profiles.find((p) => p.anchorId === args.where.anchorId);
        return row ? { ...row } : null;
      }),
    },
    emergencyMedicalDossier: {
      findUnique: vi.fn(async (args: { where: { userId: string } }) => {
        const row = dossiers.find((d) => d.userId === args.where.userId);
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { userId: string };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const d of dossiers) {
            if (d.userId === args.where.userId) {
              Object.assign(d, args.data);
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, tokens, incidents, users, profiles, dossiers };
}

/**
 * Deterministic verifier fake mirroring the mint-side signer: the raw token is
 * `signed.<base64url(JSON(claims))>`. It decodes the claims and, like a real
 * JWT verify, THROWS on a wrong signature prefix or a past `exp`.
 */
function makeVerifier(now: () => number): EmergencyRouteDeps["verifyToken"] {
  return (rawToken: string) => {
    const [prefix, body] = rawToken.split(".");
    if (prefix !== "signed" || !body) {
      throw new Error("bad signature");
    }
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as EmergencyTokenClaims;
    if (claims.exp * 1000 <= now()) {
      throw new Error("expired");
    }
    return claims;
  };
}

function signToken(claims: EmergencyTokenClaims): string {
  return `signed.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
}

function makeClaims(
  overrides: Partial<EmergencyTokenClaims> = {},
): EmergencyTokenClaims {
  const iat = Math.floor(NOW / 1000);
  return {
    incidentId: INCIDENT_ID,
    scope: EMERGENCY_TRIAGE_SCOPE,
    iat,
    exp: iat + 60 * 60,
    ...overrides,
  };
}

function incidentRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: INCIDENT_ID,
    circleId: CIRCLE_ID,
    anchorId: ANCHOR_ID,
    stage: STAGE_4,
    status: "OPEN",
    auditTrail: [{ stage: STAGE_4, at: "t0", cause: "dispatch" }],
    resolutionSource: null,
    ...overrides,
  };
}

function anchorUser(): UserRow {
  return { id: ANCHOR_ID, preferredName: "Amma" };
}

function profileRow(): ProfileRow {
  return {
    anchorId: ANCHOR_ID,
    society: "Green Meadows",
    building: "Tower B",
    flat: "402",
    doorAccess: "Gate PIN 4455",
    primaryObserverPhone: "+919812345678",
  };
}

function dossierRow(overrides: Partial<DossierRow> = {}): DossierRow {
  return {
    id: "dossier_1",
    userId: ANCHOR_ID,
    encryptedPayload: Buffer.from("cipher"),
    iv: Buffer.from("iv"),
    authTag: Buffer.from("tag"),
    encryptedEmergencyKey: Buffer.from("wrapped"),
    accessState: "RELEASED_EMERGENCY",
    ...overrides,
  };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  const now = () => NOW;
  return buildApp({
    env: testEnv(),
    loggerEnabled: false,
    now,
    emergencyTokenVerifier: makeVerifier(now),
    ...overrides,
  });
}

/** Serialize a response body and assert none of the clinical secrets appear. */
function assertNoClinicalLeak(serialized: string): void {
  for (const secret of CLINICAL_SECRETS) {
    expect(serialized).not.toContain(secret);
  }
}

// --------------------------------------------------------------------------
// The context the property varies over — exactly the design generator.
// --------------------------------------------------------------------------

interface Context {
  viewer: Viewer;
  stage: string;
  tokenValid: boolean;
  resolved: boolean;
}

const contextArb: fc.Arbitrary<Context> = fc.record({
  viewer: fc.constantFrom(...VIEWERS),
  stage: fc.constantFrom(...ALL_STAGES),
  tokenValid: fc.boolean(),
  resolved: fc.boolean(),
});

describe("Emergency medical dossier access gating — Property 23 (R33.2/R33.3/R33.4)", () => {
  it("releases dossier plaintext IFF responder-portal + valid token + Stage-4 + not-resolved; never to admin/observer", async () => {
    await fc.assert(
      fc.asyncProperty(contextArb, async (ctx) => {
        // Encode the context into the fixtures + request:
        //   - resolved: the incident is RESOLVED and, per R33.4, its emergency
        //     token was invalidated at resolution time (revoked access);
        //   - tokenValid: a good signature + live row vs a bad signature (the
        //     responder holds no verifiable credential).
        const decrypt = vi.fn(() => DECRYPTED);

        const claims = makeClaims();
        const goodRaw = signToken(claims);
        const tokenRow: TokenRow = {
          id: "tok_1",
          incidentId: INCIDENT_ID,
          tokenHash: hashEmergencyToken(goodRaw),
          scope: EMERGENCY_TRIAGE_SCOPE,
          expiresAt: new Date(NOW + 30 * 60 * 1000),
          // R33.4: resolution revokes access by invalidating the token.
          invalidatedAt: ctx.resolved ? new Date(NOW - 1000) : null,
        };

        const incident = incidentRow({
          stage: ctx.stage,
          status: ctx.resolved ? "RESOLVED" : "OPEN",
          ...(ctx.resolved ? { resolutionSource: "RESPONDER_CONFIRMED" } : {}),
        });
        // When resolved, the dossier access state is revoked too (R33.4).
        const dossier = dossierRow(
          ctx.resolved ? { accessState: "EXPIRED" } : {},
        );

        const { prisma } = makeFakePrisma({
          tokens: [tokenRow],
          incidents: [incident],
          users: [anchorUser()],
          profiles: [profileRow()],
          dossiers: [dossier],
        });
        const app = await buildTestApp({
          prisma,
          emergencyDossierDecryptor: decrypt,
        });

        try {
          // The release law: plaintext is readable IFF the responder portal
          // holds a valid token whose bound incident is at Stage-4 and is not
          // yet resolved (revoked on resolution).
          const shouldRelease =
            ctx.viewer === "RESPONDER_PORTAL" &&
            ctx.tokenValid &&
            !ctx.resolved &&
            ctx.stage === STAGE_4;

          if (ctx.viewer === "RESPONDER_PORTAL") {
            // A valid viewer presents the good token; an invalid one presents a
            // token with a broken signature (no verifiable credential at all).
            const presented = ctx.tokenValid ? goodRaw : "tampered.deadbeef";
            const res = await app.inject({
              method: "GET",
              url: `/api/v1/emergency/${encodeURIComponent(presented)}`,
              headers: { "user-agent": "GuardPhone/1.0" },
            });

            const raw = res.body;

            if (shouldRelease) {
              expect(res.statusCode).toBe(200);
              const body = res.json();
              // The dossier plaintext is present and carries the clinical
              // fields (R33.3), decrypted exactly once via the break-glass seam.
              expect(body.dossier).toBeDefined();
              expect(body.dossier.bloodGroup).toBe(DECRYPTED.bloodGroup);
              expect(body.dossier.allergies).toEqual(DECRYPTED.allergies);
              expect(decrypt).toHaveBeenCalledTimes(1);
            } else {
              // Not released: either a 200 triage payload WITHOUT the dossier
              // (valid token but not Stage-4 / not resolved-safe), or a 410
              // concluded body (invalid or revoked token). In every case no
              // clinical secret may appear and decrypt is never called.
              if (res.statusCode === 200) {
                expect(res.json().dossier).toBeUndefined();
              } else {
                expect(res.statusCode).toBe(410);
                expect(res.json()).toMatchObject({ concluded: true });
              }
              expect(decrypt).not.toHaveBeenCalled();
              assertNoClinicalLeak(raw);
            }
          } else {
            // R33.2 — Admin_Users and ordinary Observer surfaces: there is NO
            // dossier-plaintext GET on any authenticated surface. Probe the
            // surfaces those roles would use and assert the clinical secrets
            // never appear and the break-glass decrypt is never invoked.
            const probes = [
              "/api/v1/medical-dossier",
              `/api/v1/incidents/${INCIDENT_ID}`,
              `/api/v1/incidents/${INCIDENT_ID}/dossier`,
              `/api/v1/emergency/${INCIDENT_ID}/dossier`,
            ];
            for (const url of probes) {
              const res = await app.inject({ method: "GET", url });
              // Whatever the surface returns (404 no-such-route, 401/403 auth,
              // or a payload), it must never carry the clinical plaintext.
              assertNoClinicalLeak(res.body);
            }
            // The break-glass decryptor is reachable ONLY from the Stage-4
            // responder path, so an admin/observer probe never triggers it.
            expect(decrypt).not.toHaveBeenCalled();
            // shouldRelease is false for these viewers by construction.
            expect(shouldRelease).toBe(false);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);
});

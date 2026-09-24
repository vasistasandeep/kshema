// Feature: kshema-safety-platform, Property 20: Responder payload completeness
// and exclusion.
//
// For all Hyperlocal_Contact_Profiles and bound incidents, the
// Ephemeral_Responder_Portal payload SHALL include the Anchor preferred display
// name, the society/building/flat identifiers, the door-access instructions and
// smart-lock backup codes, and a Primary Observer dialer number, SHALL include
// the Emergency_Medical_Dossier if and only if the incident is at
// STAGE_4_HYPERLOCAL_DISPATCH, and SHALL never contain any location-trace,
// financial, or chat field.
/**
 * Property-based test for `GET /api/v1/emergency/:token` (task 13.5 — Property 20).
 *
 * Validates: Requirements 29.6, 29.7, 33.3
 *
 * Reuses the hermetic harness style of `emergency.test.ts`: a fake Prisma client
 * backs the token / incident / user / profile / dossier reads and writes, the
 * token verifier and dossier decryptor are injected fakes, and the event emitter
 * is a captured no-op. No live DB / Redis / JWT plugin / escrow key is needed.
 *
 * The property draws, over ≥100 fast-check iterations:
 *   - an arbitrary incident stage (any of the four Escalation_Stages);
 *   - arbitrary presence + values for society / building / flat / door-access /
 *     Primary Observer dialer on the Hyperlocal_Contact_Profile (each field may
 *     be absent to prove the payload only surfaces what the profile carries);
 *   - an arbitrary Anchor preferred name (or null → default "Resident");
 *   - whether a stored, decryptable Emergency_Medical_Dossier exists.
 *
 * and asserts three laws for every valid-token GET:
 *   (completeness) the response ALWAYS carries `preferredName`, `incidentStage`,
 *     and `smartLockBackupCodes`; and it echoes EXACTLY the society/building/
 *     flat/door-access/dialer values the profile provided (present iff the
 *     profile field was present);
 *   (dossier gating, R33.3) `dossier` is present IFF the incident stage is
 *     STAGE_4_HYPERLOCAL_DISPATCH AND a stored dossier exists — and the
 *     break-glass decryptor is invoked ONLY in that case;
 *   (exclusion, R29.7) the response NEVER contains any location-trace,
 *     financial, or chat key at the top level or nested in the dossier.
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

/** Fields that must NEVER appear in a responder payload (R29.7). */
const FORBIDDEN_KEYS = [
  "location",
  "locationHistory",
  "locationTrace",
  "coordinates",
  "gps",
  "latitude",
  "longitude",
  "trace",
  "financial",
  "payment",
  "billing",
  "invoice",
  "subscription",
  "chat",
  "messages",
  "conversation",
  "history",
] as const;

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
// Fake Prisma fixtures (trimmed to exactly what the GET route reads/writes).
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
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, tokens, incidents, users, profiles, dossiers };
}

function makeFakeEmitter(): BuildAppOptions["eventEmitter"] {
  return {
    emit: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["eventEmitter"];
}

/**
 * Deterministic verifier fake (mirrors `emergency.test.ts`): the raw token is
 * `signed.<base64url(JSON(claims))>`. It decodes the claims and, like a real
 * JWT verify, throws on a wrong prefix or a past `exp`.
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

/** A valid raw token + persisted hash-only row bound to `incidentId`. */
function makeToken(incidentId = "incident_1") {
  const iat = Math.floor(NOW / 1000);
  const claims: EmergencyTokenClaims = {
    incidentId,
    scope: EMERGENCY_TRIAGE_SCOPE,
    iat,
    exp: iat + 60 * 60,
  };
  const raw = signToken(claims);
  const row: TokenRow = {
    id: "tok_1",
    incidentId,
    tokenHash: hashEmergencyToken(raw),
    scope: EMERGENCY_TRIAGE_SCOPE,
    expiresAt: new Date(NOW + 30 * 60 * 1000),
    invalidatedAt: null,
  };
  return { raw, row };
}

/**
 * A fully-populated decrypted dossier view (matches EmergencyDossierViewSchema).
 * The break-glass decryptor fake returns this; the property asserts it is only
 * ever invoked at Stage-4 with a stored dossier.
 */
const DECRYPTED: DecryptedDossierView = {
  bloodGroup: "O+",
  allergies: ["penicillin"],
  chronicConditions: ["hypertension"],
  criticalMedications: ["amlodipine"],
  attendingDoctorName: "Dr. Rao",
  attendingDoctorPhone: "+919800000000",
  healthInsurancePolicy: "POL-123",
};

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  const now = () => NOW;
  return buildApp({
    env: testEnv(),
    loggerEnabled: false,
    now,
    emergencyTokenVerifier: makeVerifier(now),
    eventEmitter: makeFakeEmitter(),
    ...overrides,
  });
}

/**
 * A scenario draws an incident stage, optional profile fields, an optional
 * Anchor preferred name, and whether a stored dossier exists. Each string field
 * is either absent (null) or a non-empty value so we can prove the payload only
 * surfaces what the profile actually carries.
 */
interface Scenario {
  stage: (typeof ALL_STAGES)[number];
  society: string | null;
  building: string | null;
  flat: string | null;
  doorAccess: string | null;
  primaryObserverPhone: string | null;
  preferredName: string | null;
  hasDossier: boolean;
}

// Constrain generated profile values to the DTO's valid input space:
// `NonEmptyString` is `z.string().trim().min(1)`, so a value must be non-empty
// AFTER trimming. We build from visible characters and re-check the trim so a
// whitespace-only string (which the response schema would reject → 500) is
// never fed as if it were valid stored profile data.
const nonEmpty = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);
const optionalString = fc.option(nonEmpty, { nil: null });
const optionalPhone = fc.option(
  fc.stringMatching(/^\+[1-9][0-9]{7,13}$/),
  { nil: null },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  stage: fc.constantFrom(...ALL_STAGES),
  society: optionalString,
  building: optionalString,
  flat: optionalString,
  doorAccess: optionalString,
  primaryObserverPhone: optionalPhone,
  preferredName: optionalString,
  hasDossier: fc.boolean(),
});

/** Recursively collect every object key appearing anywhere in a JSON value. */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k.toLowerCase());
      collectKeys(v, acc);
    }
  }
  return acc;
}

describe("GET /api/v1/emergency/:token — Property 20 (R29.6, R29.7, R33.3)", () => {
  it("always includes required triage fields, gates the dossier on Stage-4, and never leaks location/financial/chat data", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const { raw, row } = makeToken();
        const decrypt = vi.fn(() => DECRYPTED);
        const { prisma } = makeFakePrisma({
          tokens: [row],
          incidents: [
            {
              id: "incident_1",
              circleId: "circle_1",
              anchorId: "anchor_1",
              stage: s.stage,
              status: "OPEN",
              auditTrail: [],
            },
          ],
          users: [{ id: "anchor_1", preferredName: s.preferredName }],
          profiles: [
            {
              anchorId: "anchor_1",
              society: s.society,
              building: s.building,
              flat: s.flat,
              doorAccess: s.doorAccess,
              primaryObserverPhone: s.primaryObserverPhone,
            },
          ],
          dossiers: s.hasDossier
            ? [
                {
                  id: "dossier_1",
                  userId: "anchor_1",
                  encryptedPayload: Buffer.from("cipher"),
                  iv: Buffer.from("iv"),
                  authTag: Buffer.from("tag"),
                  encryptedEmergencyKey: Buffer.from("wrapped"),
                  accessState: "RELEASED_EMERGENCY",
                },
              ]
            : [],
        });

        const app = await buildTestApp({
          prisma,
          emergencyDossierDecryptor: decrypt,
        });

        try {
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
          });

          expect(res.statusCode).toBe(200);
          const body = res.json() as Record<string, unknown>;

          // (completeness, R29.6) always-present fields.
          expect(typeof body.preferredName).toBe("string");
          expect((body.preferredName as string).length).toBeGreaterThan(0);
          expect(body.incidentStage).toBe(s.stage);
          expect(Array.isArray(body.smartLockBackupCodes)).toBe(true);

          // preferredName echoes the Anchor name (trimmed by the DTO), or the
          // "Resident" default when absent.
          expect(body.preferredName).toBe(
            s.preferredName ? s.preferredName.trim() : "Resident",
          );

          // (completeness, R29.6) profile-derived fields appear IFF the profile
          // carried them, and carry exactly the stored value.
          // The response DTO trims string fields (`NonEmptyString` =
          // `.trim().min(1)`), so a stored value echoes back trimmed.
          const expectField = (
            key: string,
            provided: string | null,
          ) => {
            if (provided === null) {
              expect(key in body).toBe(false);
            } else {
              expect(body[key]).toBe(provided.trim());
            }
          };
          expectField("society", s.society);
          expectField("building", s.building);
          expectField("flat", s.flat);
          expectField("doorAccessInstructions", s.doorAccess);
          expectField("primaryObserverDialer", s.primaryObserverPhone);

          // (dossier gating, R33.3) present IFF Stage-4 AND a dossier exists;
          // the break-glass decryptor is invoked only in that exact case.
          const dossierExpected = s.stage === STAGE_4 && s.hasDossier;
          if (dossierExpected) {
            expect(body.dossier).toBeDefined();
            expect(decrypt).toHaveBeenCalledTimes(1);
          } else {
            expect(body.dossier).toBeUndefined();
            expect(decrypt).not.toHaveBeenCalled();
          }

          // (exclusion, R29.7) no forbidden key anywhere in the payload.
          const keys = collectKeys(body);
          for (const forbidden of FORBIDDEN_KEYS) {
            expect(keys.has(forbidden.toLowerCase())).toBe(false);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});

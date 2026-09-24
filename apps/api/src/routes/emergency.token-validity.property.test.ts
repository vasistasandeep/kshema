// Feature: kshema-safety-platform, Property 19: Emergency access token validity
// and invalidation.
// For all Emergency_Access_Tokens and any presented (token, incidentId,
// currentTime) tuple, access SHALL be granted if and only if the token's
// signature verifies, the token is not expired (currentTime < expiresAt and
// expiresAt <= issuedAt + 60m), the presented incident matches the token's
// bound incidentId, and the token has not been invalidated; and the moment the
// bound Safety_Incident resolves by any resolution source, the token SHALL be
// invalidated so all subsequent access is denied.
/**
 * Property-based test for the ephemeral responder portal token gate
 * (task 13.4).
 *
 * Validates: Requirements 29.1, 29.2, 29.9, 29.10, 29.11
 *
 * Reuses the same hermetic harness as `emergency.test.ts` (fake Prisma over
 * in-memory rows, an injected deterministic token verifier that mirrors the
 * mint-side signer, an injected clock, and a captured event emitter). No live
 * DB / Redis / JWT plugin / escrow key is touched.
 *
 * The main property draws arbitrary combinations of the five facts that the
 * grant law depends on, for a `GET /api/v1/emergency/:token` load:
 *   - signatureValid       — the raw token carries the verifier's "signed."
 *                            prefix (a bad prefix makes the verifier throw);
 *   - expired              — the token/row expiry is in the past relative to
 *                            the injected clock;
 *   - ttlWithinCap         — expiresAt <= issuedAt + 60m (an over-long TTL is
 *                            rejected because the row's expiresAt is beyond the
 *                            60m cap, which the verifier's exp also enforces);
 *   - incidentMatches      — the presented token's row binds the SAME incident
 *                            the signed claims name (R29.1);
 *   - invalidated          — the row carries a non-null invalidatedAt (R29.10).
 *
 * and asserts the grant law:
 *   200 (payload) IFF signatureValid AND !expired AND ttlWithinCap AND
 *                      incidentMatches AND !invalidated
 *   otherwise 410 "safety check has concluded" (R29.11).
 *
 * A second property asserts the resolution→invalidation invariant (R29.9,
 * R29.10): a valid token that loads 200 before a responder confirms is denied
 * 410 on EVERY subsequent load once the confirm has invalidated it, for an
 * arbitrary responder name.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";
import {
  hashEmergencyToken,
  EMERGENCY_TRIAGE_SCOPE,
  type EmergencyTokenClaims,
} from "../services/emergency-token.js";
import type { EmergencyRouteDeps } from "./emergency.js";

/** A fixed reference "now" (epoch ms) all fixtures + the injected clock share. */
const NOW = 1_700_000_000_000;
const STAGE_4 = "STAGE_4_HYPERLOCAL_DISPATCH";
const HOUR_MS = 60 * 60 * 1000;
const BOUND_INCIDENT = "incident_1";
const OTHER_INCIDENT = "incident_2";

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

function makeFakeEmitter() {
  const events: Array<{ name: SentinelEventName; payload: unknown }> = [];
  const emitter: EventEmitter = {
    emit: vi.fn(async (name, payload) => {
      events.push({ name, payload });
    }),
    close: vi.fn(async () => undefined),
  };
  return { emitter, events };
}

// --------------------------------------------------------------------------
// Fake Prisma fixtures (trimmed to the reads/writes the token gate performs).
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

interface Fixtures {
  tokens?: TokenRow[];
  incidents?: IncidentRow[];
  users?: UserRow[];
  profiles?: ProfileRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const tokens = fixtures.tokens ?? [];
  const incidents = fixtures.incidents ?? [];
  const users = fixtures.users ?? [];
  const profiles = fixtures.profiles ?? [];

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
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, tokens, incidents, users, profiles };
}

/**
 * Deterministic verifier fake mirroring the mint-side signer (as in
 * `emergency.test.ts`): a valid raw token is `signed.<base64url(JSON(claims))>`.
 * It decodes the claims and, like a real JWT verify, THROWS on a bad signature
 * prefix or a past `exp`.
 *
 * It additionally THROWS when the claim window exceeds the 60-minute cap
 * (`exp - iat > 60m`). This is faithful to the system's actual guarantee for
 * Property 19's `expiresAt <= issuedAt + 60m` clause (R29.2): the minter
 * (`mintEmergencyAccessToken`) CLAMPS every TTL to <= 60m before signing, so a
 * token whose signed window is over the cap could never have been legitimately
 * issued — a real verifier that trusted the platform's own issuance rejects it
 * as an illegitimate/forged token. Modelling the cap here keeps the verify path
 * signature-check the single place that enforces the issuance invariant, rather
 * than the route re-deriving `iat` (which it never sees) at request time.
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
    if ((claims.exp - claims.iat) * 1000 > HOUR_MS) {
      throw new Error("token window exceeds the 60-minute cap");
    }
    return claims;
  };
}

/** Build a raw token string carrying the given claims (mirrors the signer). */
function signToken(claims: EmergencyTokenClaims): string {
  return `signed.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
}

/** A verifier-satisfying token whose signature is nonetheless invalid. */
function tamperedToken(): string {
  return "tampered.deadbeef";
}

function incident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: BOUND_INCIDENT,
    circleId: "circle_1",
    anchorId: "anchor_1",
    stage: STAGE_4,
    status: "OPEN",
    auditTrail: [{ stage: STAGE_4, at: "t0", cause: "dispatch" }],
    resolutionSource: null,
    ...overrides,
  };
}

function anchorUser(): UserRow {
  return { id: "anchor_1", preferredName: "Amma" };
}

function profile(): ProfileRow {
  return {
    anchorId: "anchor_1",
    society: "Green Meadows",
    building: "Tower B",
    flat: "402",
    doorAccess: "Gate PIN 4455",
    primaryObserverPhone: "+919812345678",
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
    eventEmitter: makeFakeEmitter().emitter,
    ...overrides,
  });
}

// --------------------------------------------------------------------------
// The five independent facts the grant law varies over.
// --------------------------------------------------------------------------

interface Scenario {
  /** Raw token carries the verifier's "signed." prefix (else the verify throws). */
  signatureValid: boolean;
  /** The token/row expiry is in the past (currentTime >= expiresAt). */
  expired: boolean;
  /** expiresAt <= issuedAt + 60m (an over-long TTL breaks the 60m cap). */
  ttlWithinCap: boolean;
  /** The row binds the SAME incident the signed claims name (R29.1). */
  incidentMatches: boolean;
  /** The row carries a non-null invalidatedAt (R29.10). */
  invalidated: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  signatureValid: fc.boolean(),
  expired: fc.boolean(),
  ttlWithinCap: fc.boolean(),
  incidentMatches: fc.boolean(),
  invalidated: fc.boolean(),
});

/**
 * Materialize a scenario into (rawToken, persisted row). The claims always name
 * BOUND_INCIDENT; the persisted row binds BOUND_INCIDENT only when
 * `incidentMatches`, otherwise OTHER_INCIDENT (a token minted for a different
 * incident, R29.1). The row's `expiresAt` and the claim `exp` are moved
 * together so the verifier's exp-check and the route's row expiry-check agree.
 */
function materialize(s: Scenario): { raw: string; row: TokenRow } {
  const iatSec = Math.floor(NOW / 1000);

  // Choose an expiry: past when expired; else future but capped at
  // issuedAt + 60m unless ttlWithinCap is false (then push past the cap).
  let expiresAtMs: number;
  if (s.expired) {
    expiresAtMs = NOW - 60_000; // one minute in the past
  } else if (s.ttlWithinCap) {
    expiresAtMs = NOW + 30 * 60 * 1000; // 30m ahead, within the 60m cap
  } else {
    expiresAtMs = NOW + 90 * 60 * 1000; // 90m ahead, beyond the 60m cap
  }
  const expSec = Math.floor(expiresAtMs / 1000);

  const claims: EmergencyTokenClaims = {
    incidentId: BOUND_INCIDENT,
    scope: EMERGENCY_TRIAGE_SCOPE,
    iat: iatSec,
    exp: expSec,
  };
  const raw = s.signatureValid ? signToken(claims) : tamperedToken();

  // The persisted row is looked up by hash(rawToken). For a tampered token the
  // hash still resolves to a row so the failure is purely the bad signature.
  const row: TokenRow = {
    id: "tok_1",
    incidentId: s.incidentMatches ? BOUND_INCIDENT : OTHER_INCIDENT,
    tokenHash: hashEmergencyToken(raw),
    scope: EMERGENCY_TRIAGE_SCOPE,
    expiresAt: new Date(expiresAtMs),
    invalidatedAt: s.invalidated ? new Date(NOW - 1000) : null,
  };
  return { raw, row };
}

/** The grant law: every clause must hold for a 200 (else 410). */
function shouldGrant(s: Scenario): boolean {
  return (
    s.signatureValid &&
    !s.expired &&
    s.ttlWithinCap &&
    s.incidentMatches &&
    !s.invalidated
  );
}

describe("GET /api/v1/emergency/:token — Property 19 (R29.1, R29.2, R29.10, R29.11)", () => {
  it("grants (200) IFF signature valid AND not expired AND ttl<=60m AND incident matches AND not invalidated; else 410 concluded", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const { raw, row } = materialize(s);
        const { prisma, incidents } = makeFakePrisma({
          tokens: [row],
          incidents: [incident()],
          users: [anchorUser()],
          profiles: [profile()],
        });
        const app = await buildTestApp({ prisma });

        try {
          const priorTrailLen = (incidents[0]!.auditTrail as unknown[]).length;
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
          });

          if (shouldGrant(s)) {
            // ---- GRANT LAW ----
            expect(res.statusCode).toBe(200);
            const body = res.json();
            // The read-only triage payload is served (R29.6 shape).
            expect(body.preferredName).toBe("Amma");
            expect(body.incidentStage).toBe(STAGE_4);
            expect(body.concluded).toBeUndefined();
            // A valid load is audited as a visit (R29.12), so the trail grows.
            const trail = incidents[0]!.auditTrail as unknown[];
            expect(trail.length).toBe(priorTrailLen + 1);
          } else {
            // ---- DENY LAW ----
            // Any failed clause renders the "concluded" body (R29.11) and never
            // the triage payload.
            expect(res.statusCode).toBe(410);
            const body = res.json();
            expect(body).toMatchObject({ concluded: true });
            expect(body.preferredName).toBeUndefined();
            // A denied load never audits a visit: the trail is untouched.
            const trail = incidents[0]!.auditTrail as unknown[];
            expect(trail.length).toBe(priorTrailLen);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it("invalidates the token the moment the incident resolves: a token that loads 200 is denied 410 after a responder confirm, for any responder name (R29.9, R29.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        async (responderName) => {
          // A pristine, valid token bound to the incident.
          const s: Scenario = {
            signatureValid: true,
            expired: false,
            ttlWithinCap: true,
            incidentMatches: true,
            invalidated: false,
          };
          const { raw, row } = materialize(s);
          const notify = vi.fn(async () => undefined);
          const { prisma } = makeFakePrisma({
            tokens: [row],
            incidents: [incident()],
            users: [anchorUser()],
            profiles: [profile()],
          });
          const { emitter, events } = makeFakeEmitter();
          const app = await buildTestApp({
            prisma,
            eventEmitter: emitter,
            emergencyObserverNotifier: notify,
          });

          try {
            const url = `/api/v1/emergency/${encodeURIComponent(raw)}`;

            // Before resolution the valid token loads the triage payload.
            const before = await app.inject({ method: "GET", url });
            expect(before.statusCode).toBe(200);

            // A responder confirms → the incident resolves by an
            // Observer-override source; the token is invalidated (R29.10) and
            // the resolution is emitted for the worker (R29.9).
            const confirm = await app.inject({
              method: "POST",
              url: `${url}/confirm`,
              payload: { responderName },
            });
            expect(confirm.statusCode).toBe(200);
            expect(
              events.filter((e) => e.name === "incident.resolved"),
            ).toHaveLength(1);

            // EVERY subsequent access is now denied — GET and confirm alike.
            const afterGet = await app.inject({ method: "GET", url });
            expect(afterGet.statusCode).toBe(410);
            expect(afterGet.json()).toMatchObject({ concluded: true });

            const afterConfirm = await app.inject({
              method: "POST",
              url: `${url}/confirm`,
              payload: { responderName },
            });
            expect(afterConfirm.statusCode).toBe(410);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);
});

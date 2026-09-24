/**
 * Unit tests for the ephemeral first-responder emergency routes (task 13.3 —
 * R29.6, R29.7, R29.9, R29.10, R29.11, R29.12, R33.3, R33.4).
 *
 * Hermetic: a fake Prisma client backs the token / incident / profile / dossier
 * reads and writes; a fake event emitter captures `incident.resolved`; the
 * token verifier, dossier decryptor, and Observer notifier are injected fakes.
 * No live DB / Redis / JWT plugin / escrow key is needed.
 *
 * Coverage:
 *   - GET returns the triage payload (name, society/building/flat, door codes,
 *     Primary Observer dialer) and EXCLUDES location/financial/chat (R29.6/7);
 *   - GET includes the dossier IFF the incident is at STAGE_4 (R33.3);
 *   - GET records the visit with IP + user-agent (R29.12);
 *   - GET with an invalid signature, wrong incident binding, invalidated, or
 *     expired token → 410 concluded (R29.10, R29.11);
 *   - POST /confirm resolves with RESPONDER_CONFIRMED, invalidates the token
 *     (R29.10), revokes dossier access (R33.4), notifies Observers (R29.9),
 *     logs the click (R29.12), and emits `incident.resolved` (R29.9);
 *   - POST /confirm on an invalidated token → 410, nothing emitted.
 */
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
import type {
  EmergencyRouteDeps,
  DecryptedDossierView,
} from "./emergency.js";

const NOW = 1_700_000_000_000;
const STAGE_4 = "STAGE_4_HYPERLOCAL_DISPATCH";
const STAGE_3 = "STAGE_3_OBSERVER_SILENT_ALERT";

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
// Fake Prisma fixtures.
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
 * A deterministic verifier fake mirroring the mint-side signer used by the 13.1
 * service test: the raw token is `signed.<base64url(JSON(claims))>`. It decodes
 * the claims and, like a real JWT verify, THROWS when the signature prefix is
 * wrong or the `exp` is in the past.
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

/** Build a raw token string carrying the given claims (mirrors the signer). */
function signToken(claims: EmergencyTokenClaims): string {
  return `signed.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
}

function makeClaims(overrides: Partial<EmergencyTokenClaims> = {}): EmergencyTokenClaims {
  const iat = Math.floor(NOW / 1000);
  return {
    incidentId: "incident_1",
    scope: EMERGENCY_TRIAGE_SCOPE,
    iat,
    exp: iat + 60 * 60,
    ...overrides,
  };
}

/** A valid raw token + persisted hash-only row bound to `incidentId`. */
function makeToken(
  incidentId = "incident_1",
  overrides: Partial<TokenRow> = {},
  claimOverrides: Partial<EmergencyTokenClaims> = {},
) {
  const claims = makeClaims({ incidentId, ...claimOverrides });
  const raw = signToken(claims);
  const row: TokenRow = {
    id: "tok_1",
    incidentId,
    tokenHash: hashEmergencyToken(raw),
    scope: EMERGENCY_TRIAGE_SCOPE,
    expiresAt: new Date(NOW + 30 * 60 * 1000),
    invalidatedAt: null,
    ...overrides,
  };
  return { raw, row };
}

function incident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: "incident_1",
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

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    anchorId: "anchor_1",
    society: "Green Meadows",
    building: "Tower B",
    flat: "402",
    doorAccess: "Gate PIN 4455, lift to 4th floor",
    primaryObserverPhone: "+919812345678",
    ...overrides,
  };
}

function dossier(overrides: Partial<DossierRow> = {}): DossierRow {
  return {
    id: "dossier_1",
    userId: "anchor_1",
    encryptedPayload: Buffer.from("cipher"),
    iv: Buffer.from("iv"),
    authTag: Buffer.from("tag"),
    encryptedEmergencyKey: Buffer.from("wrapped"),
    accessState: "RELEASED_EMERGENCY",
    ...overrides,
  };
}

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
    // Default to a captured emitter so no test accidentally opens a live Redis.
    eventEmitter: makeFakeEmitter().emitter,
    ...overrides,
  });
}

// --------------------------------------------------------------------------
// GET /api/v1/emergency/:token
// --------------------------------------------------------------------------

describe("GET /api/v1/emergency/:token", () => {
  it("returns the triage payload with the dossier at STAGE_4 (R29.6, R33.3)", async () => {
    const { raw, row } = makeToken();
    const decrypt = vi.fn(() => DECRYPTED);
    const { prisma, incidents } = makeFakePrisma({
      tokens: [row],
      incidents: [incident()],
      users: [anchorUser()],
      profiles: [profile()],
      dossiers: [dossier()],
    });
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeFakeEmitter().emitter,
      emergencyDossierDecryptor: decrypt,
    });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
        headers: { "user-agent": "GuardPhone/1.0", "x-forwarded-for": "203.0.113.5" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        preferredName: "Amma",
        society: "Green Meadows",
        building: "Tower B",
        flat: "402",
        doorAccessInstructions: "Gate PIN 4455, lift to 4th floor",
        primaryObserverDialer: "+919812345678",
        incidentStage: STAGE_4,
        dossier: {
          bloodGroup: "O+",
          allergies: ["penicillin"],
        },
      });

      // Dossier was decrypted exactly once, via the injected break-glass seam.
      expect(decrypt).toHaveBeenCalledTimes(1);

      // The visit was audited with IP + user-agent (R29.12).
      const trail = incidents[0]!.auditTrail as Array<Record<string, unknown>>;
      const visit = trail.find((e) => e.type === "RESPONDER_PORTAL_VISIT");
      expect(visit).toMatchObject({
        ip: "203.0.113.5",
        userAgent: "GuardPhone/1.0",
      });
    } finally {
      await app.close();
    }
  });

  it("excludes location, financial, and chat fields from the payload (R29.7)", async () => {
    const { raw, row } = makeToken();
    const { prisma } = makeFakePrisma({
      tokens: [row],
      incidents: [incident()],
      users: [anchorUser()],
      profiles: [profile()],
    });
    const app = await buildTestApp({ prisma, emergencyDossierDecryptor: vi.fn(() => DECRYPTED) });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
      });
      expect(res.statusCode).toBe(200);
      const keys = Object.keys(res.json());
      for (const forbidden of [
        "location",
        "locationHistory",
        "coordinates",
        "financial",
        "payment",
        "chat",
        "messages",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });

  it("omits the dossier below STAGE_4 (R33.3)", async () => {
    const { raw, row } = makeToken();
    const decrypt = vi.fn(() => DECRYPTED);
    const { prisma } = makeFakePrisma({
      tokens: [row],
      incidents: [incident({ stage: STAGE_3 })],
      users: [anchorUser()],
      profiles: [profile()],
      dossiers: [dossier()],
    });
    const app = await buildTestApp({ prisma, emergencyDossierDecryptor: decrypt });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dossier).toBeUndefined();
      // Never decrypt below Stage-4.
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 410 concluded for an invalid signature (R29.11)", async () => {
    const { row } = makeToken();
    const { prisma } = makeFakePrisma({ tokens: [row], incidents: [incident()] });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent("tampered.deadbeef")}`,
      });
      expect(res.statusCode).toBe(410);
      expect(res.json()).toMatchObject({ concluded: true });
    } finally {
      await app.close();
    }
  });

  it("returns 410 when the token binds a different incident than its row (R29.1)", async () => {
    // Claims say incident_2, but the persisted row is bound to incident_1.
    const claims = makeClaims({ incidentId: "incident_2" });
    const raw = signToken(claims);
    const row: TokenRow = {
      id: "tok_1",
      incidentId: "incident_1",
      tokenHash: hashEmergencyToken(raw),
      scope: EMERGENCY_TRIAGE_SCOPE,
      expiresAt: new Date(NOW + 30 * 60 * 1000),
      invalidatedAt: null,
    };
    const { prisma } = makeFakePrisma({ tokens: [row], incidents: [incident()] });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
      });
      expect(res.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });

  it("returns 410 for an invalidated token (R29.10)", async () => {
    const { raw, row } = makeToken("incident_1", {
      invalidatedAt: new Date(NOW - 1000),
    });
    const { prisma } = makeFakePrisma({ tokens: [row], incidents: [incident()] });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
      });
      expect(res.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });

  it("returns 410 for an expired token (R29.2)", async () => {
    // Row expiry in the past; claims still parse but the row is stale.
    const { raw, row } = makeToken(
      "incident_1",
      { expiresAt: new Date(NOW - 1000) },
      { exp: Math.floor(NOW / 1000) + 60 * 60 },
    );
    const { prisma } = makeFakePrisma({ tokens: [row], incidents: [incident()] });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}`,
      });
      expect(res.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// POST /api/v1/emergency/:token/confirm
// --------------------------------------------------------------------------

describe("POST /api/v1/emergency/:token/confirm", () => {
  it("resolves with RESPONDER_CONFIRMED, invalidates the token, revokes the dossier, notifies Observers, and emits (R29.9/10, R33.4)", async () => {
    const { raw, row } = makeToken();
    const notify = vi.fn(async () => undefined);
    const { prisma, incidents, tokens, dossiers } = makeFakePrisma({
      tokens: [row],
      incidents: [incident()],
      users: [anchorUser()],
      profiles: [profile()],
      dossiers: [dossier()],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({
      prisma,
      eventEmitter: emitter,
      emergencyObserverNotifier: notify,
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}/confirm`,
        headers: { "user-agent": "GuardPhone/1.0", "x-forwarded-for": "203.0.113.9" },
        payload: { responderName: "Watchman Suresh" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ concluded: true });

      // Resolution source recorded; worker owns the terminal transition so the
      // status stays OPEN here (mirrors incidents.ts).
      expect(incidents[0]!.resolutionSource).toBe("RESPONDER_CONFIRMED");
      expect(incidents[0]!.status).toBe("OPEN");

      // Token invalidated (R29.10).
      expect(tokens[0]!.invalidatedAt).toBeInstanceOf(Date);

      // Dossier access revoked (R33.4).
      expect(dossiers[0]!.accessState).toBe("EXPIRED");

      // Observers notified (R29.9).
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          incidentId: "incident_1",
          circleId: "circle_1",
          anchorId: "anchor_1",
          responderName: "Watchman Suresh",
        }),
      );

      // Emits incident.resolved for the worker's atomic transition (R29.9).
      const resolved = events.filter((e) => e.name === "incident.resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.payload).toMatchObject({
        incidentId: "incident_1",
        source: "RESPONDER_CONFIRMED",
      });

      // The confirm click is audited with IP + user-agent (R29.12).
      const trail = incidents[0]!.auditTrail as Array<Record<string, unknown>>;
      const confirm = trail.find((e) => e.type === "RESPONDER_CONFIRMED");
      expect(confirm).toMatchObject({
        ip: "203.0.113.9",
        userAgent: "GuardPhone/1.0",
        responderName: "Watchman Suresh",
      });
    } finally {
      await app.close();
    }
  });

  it("returns 410 and emits nothing for an already-invalidated token (R29.10, R29.11)", async () => {
    const { raw, row } = makeToken("incident_1", {
      invalidatedAt: new Date(NOW - 1000),
    });
    const { prisma } = makeFakePrisma({
      tokens: [row],
      incidents: [incident()],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/emergency/${encodeURIComponent(raw)}/confirm`,
        payload: { responderName: "Watchman Suresh" },
      });
      expect(res.statusCode).toBe(410);
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

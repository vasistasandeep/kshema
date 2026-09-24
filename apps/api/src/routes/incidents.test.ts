/**
 * Unit tests for the incident-lifecycle / Sanctuary / medical-dossier routes
 * (task 7.1 — R11.4-R11.6, R13.6, R13.7, R13.9, R34.1, R34.3, R33.1, R33.2).
 *
 * Hermetic: a fake Prisma client backs the reads/writes each route performs,
 * and a fake event emitter captures every emitted domain event. No live
 * DB / Redis is needed. Bearer tokens are minted with the app's own `app.jwt`
 * so the `app.authenticate` guard passes.
 *
 * Coverage:
 *   - Anchor resolve emits `incident.resolved` with ANCHOR_DISMISSAL (R13.6);
 *   - authorized-Observer override emits with OBSERVER_OVERRIDE (R13.7);
 *   - an unauthorized caller's resolve -> 403, nothing emitted;
 *   - Anchor trigger-sos emits `sos.triggered` and hands off to HANDED_OFF_SOS,
 *     forwarding the one-shot decrypted location (R11.4-11.6, R13.9);
 *   - a non-Anchor trigger-sos -> 403, nothing emitted;
 *   - sanctuary create validates the 14-day cap (>14d -> 400);
 *   - sanctuary delete deactivates (isActive=false) the caller's schedule;
 *   - medical-dossier PUT stores ciphertext only (base64 -> Bytes verbatim).
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";

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

/** Fake emitter capturing every emitted event for assertions. */
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

interface IncidentRow {
  id: string;
  circleId: string;
  anchorId: string;
  stage: string;
  status: string;
  auditTrail: unknown[];
  resolutionSource?: string | null;
  openedAt: Date;
}

interface MemberRow {
  id?: string;
  circleId: string;
  userId: string;
  role: string;
  canTriggerIVR: boolean;
  canAccessBlackBox?: boolean;
}

interface SanctuaryRow {
  id: string;
  userId: string;
  startsAt: Date;
  resumesAt: Date;
  reason: string | null;
  isActive: boolean;
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
  incidents?: IncidentRow[];
  members?: MemberRow[];
  sanctuaries?: SanctuaryRow[];
  dossiers?: DossierRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const incidents = fixtures.incidents ?? [];
  const members = fixtures.members ?? [];
  const sanctuaries = fixtures.sanctuaries ?? [];
  const dossiers = fixtures.dossiers ?? [];
  let seq = 0;

  const matchesWhere = (
    row: object,
    where: Record<string, unknown>,
  ): boolean => {
    const rec = row as Record<string, unknown>;
    return Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === "object" && "in" in (v as object)) {
        return (v as { in: unknown[] }).in.includes(rec[k]);
      }
      if (v !== null && typeof v === "object" && "gt" in (v as object)) {
        return (rec[k] as Date).getTime() > (v as { gt: Date }).gt.getTime();
      }
      return rec[k] === v;
    });
  };

  const prisma = {
    safetyIncident: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return incidents.find((i) => i.id === args.where.id) ?? null;
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return incidents.find((i) => matchesWhere(i, args.where)) ?? null;
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
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: IncidentRow = {
          id: `incident_${seq}`,
          circleId: args.data.circleId as string,
          anchorId: args.data.anchorId as string,
          stage: args.data.stage as string,
          status: args.data.status as string,
          auditTrail: (args.data.auditTrail as unknown[]) ?? [],
          resolutionSource: (args.data.resolutionSource as string) ?? null,
          openedAt: new Date("2024-01-01T00:00:00.000Z"),
        };
        incidents.push(row);
        return { ...row };
      }),
    },
    circleMember: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return members.find((m) => matchesWhere(m, args.where)) ?? null;
      }),
    },
    sanctuarySchedule: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: SanctuaryRow = {
          id: `sanctuary_${seq}`,
          userId: args.data.userId as string,
          startsAt: args.data.startsAt as Date,
          resumesAt: args.data.resumesAt as Date,
          reason: (args.data.reason as string) ?? null,
          isActive: (args.data.isActive as boolean) ?? true,
        };
        sanctuaries.push(row);
        return { ...row };
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return sanctuaries.find((s) => matchesWhere(s, args.where)) ?? null;
      }),
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return sanctuaries
          .filter((s) => matchesWhere(s, args.where))
          .map((s) => ({ ...s }));
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = sanctuaries.find((s) => s.id === args.where.id);
          if (!row) throw new Error("sanctuary not found");
          Object.assign(row, args.data);
          return { ...row };
        },
      ),
    },
    emergencyMedicalDossier: {
      upsert: vi.fn(
        async (args: {
          where: { userId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = dossiers.find(
            (d) => d.userId === args.where.userId,
          );
          if (existing) {
            Object.assign(existing, args.update);
            return { id: existing.id };
          }
          seq += 1;
          const row: DossierRow = {
            id: `dossier_${seq}`,
            userId: args.create.userId as string,
            encryptedPayload: args.create.encryptedPayload as Buffer,
            iv: args.create.iv as Buffer,
            authTag: args.create.authTag as Buffer,
            encryptedEmergencyKey: args.create.encryptedEmergencyKey as Buffer,
            accessState: "LOCKED",
          };
          dossiers.push(row);
          return { id: row.id };
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, incidents, members, sanctuaries, dossiers };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

function bearer(app: FastifyInstance, userId: string): string {
  const token = app.jwt.sign({ sub: userId, channel: "MOBILE" });
  return `Bearer ${token}`;
}

function openIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: "incident_1",
    circleId: "circle_1",
    anchorId: "anchor_1",
    stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
    status: "OPEN",
    auditTrail: [
      { stage: "STAGE_1_CONVERSATIONAL_WHATSAPP", at: "t0", cause: "raise" },
    ],
    resolutionSource: null,
    openedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// POST /incidents/:id/resolve
// --------------------------------------------------------------------------

describe("POST /api/v1/incidents/:id/resolve", () => {
  it("lets the Anchor dismiss and emits incident.resolved with ANCHOR_DISMISSAL (R13.6)", async () => {
    const { prisma, incidents } = makeFakePrisma({
      incidents: [openIncident()],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/resolve",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: { source: "ANCHOR_DISMISSAL" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        incidentId: "incident_1",
        source: "ANCHOR_DISMISSAL",
        accepted: true,
      });

      // Exactly one incident.resolved event with the source.
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe("incident.resolved");
      expect(events[0]!.payload).toMatchObject({
        incidentId: "incident_1",
        source: "ANCHOR_DISMISSAL",
      });

      // Resolution source recorded + audit entry appended (worker owns the
      // terminal transition, so status stays OPEN here).
      const row = incidents[0]!;
      expect(row.resolutionSource).toBe("ANCHOR_DISMISSAL");
      expect(row.status).toBe("OPEN");
      expect(row.auditTrail).toHaveLength(2);
      expect((row.auditTrail[1] as Record<string, unknown>).source).toBe(
        "ANCHOR_DISMISSAL",
      );
    } finally {
      await app.close();
    }
  });

  it("lets an authorized Observer override and emits with OBSERVER_OVERRIDE (R13.7)", async () => {
    const { prisma } = makeFakePrisma({
      incidents: [openIncident()],
      members: [
        {
          circleId: "circle_1",
          userId: "observer_1",
          role: "OBSERVER",
          canTriggerIVR: true,
        },
      ],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/resolve",
        headers: { authorization: bearer(app, "observer_1") },
        payload: { source: "OBSERVER_OVERRIDE" },
      });

      expect(res.statusCode).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        incidentId: "incident_1",
        source: "OBSERVER_OVERRIDE",
      });
    } finally {
      await app.close();
    }
  });

  it("denies (403) a caller who is neither the Anchor nor an authorized Observer, emitting nothing", async () => {
    const { prisma, incidents } = makeFakePrisma({
      incidents: [openIncident()],
      members: [
        {
          circleId: "circle_1",
          userId: "observer_ro",
          role: "OBSERVER",
          canTriggerIVR: false,
        },
      ],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      // A member without canTriggerIVR attempting an override.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/resolve",
        headers: { authorization: bearer(app, "observer_ro") },
        payload: { source: "OBSERVER_OVERRIDE" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Forbidden");
      expect(events).toHaveLength(0);
      // No resolution source recorded.
      expect(incidents[0]!.resolutionSource).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("denies (403) a non-Anchor claiming ANCHOR_DISMISSAL", async () => {
    const { prisma } = makeFakePrisma({ incidents: [openIncident()] });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/resolve",
        headers: { authorization: bearer(app, "not_the_anchor") },
        payload: { source: "ANCHOR_DISMISSAL" },
      });

      expect(res.statusCode).toBe(403);
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for an unknown incident", async () => {
    const { prisma } = makeFakePrisma({ incidents: [] });
    const { emitter } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/nope/resolve",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: { source: "ANCHOR_DISMISSAL" },
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated resolve with 401", async () => {
    const { prisma } = makeFakePrisma({ incidents: [openIncident()] });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/resolve",
        payload: { source: "ANCHOR_DISMISSAL" },
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// POST /incidents/trigger-sos
// --------------------------------------------------------------------------

describe("POST /api/v1/incidents/trigger-sos", () => {
  it("lets an Anchor trigger a Shadow_SOS, hands off to HANDED_OFF_SOS, and emits sos.triggered with the one-shot location (R11.4-11.6, R13.9)", async () => {
    const { prisma, incidents } = makeFakePrisma({
      incidents: [openIncident()],
      members: [
        {
          circleId: "circle_1",
          userId: "anchor_1",
          role: "ANCHOR",
          canTriggerIVR: false,
        },
      ],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/trigger-sos",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: {
          decryptedLocation: {
            latitude: 12.9716,
            longitude: 77.5946,
            accuracyMeters: 8,
            capturedAt: "2024-01-01T05:30:00.000Z",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("HANDED_OFF_SOS");
      expect(body.incidentId).toBe("incident_1");

      // The existing OPEN incident was handed off (not a new one created).
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.status).toBe("HANDED_OFF_SOS");

      // sos.triggered emitted with the anchor/circle and the one-shot location.
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe("sos.triggered");
      expect(events[0]!.payload).toMatchObject({
        incidentId: "incident_1",
        circleId: "circle_1",
        anchorId: "anchor_1",
        decryptedLocation: { latitude: 12.9716, longitude: 77.5946 },
      });
    } finally {
      await app.close();
    }
  });

  it("creates a fresh HANDED_OFF_SOS incident when none is open", async () => {
    const { prisma, incidents } = makeFakePrisma({
      incidents: [],
      members: [
        {
          circleId: "circle_1",
          userId: "anchor_1",
          role: "MUTUAL",
          canTriggerIVR: true,
        },
      ],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/trigger-sos",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("HANDED_OFF_SOS");
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.status).toBe("HANDED_OFF_SOS");
      expect(events[0]!.name).toBe("sos.triggered");
    } finally {
      await app.close();
    }
  });

  it("denies (403) a non-Anchor (pure Observer) and emits nothing", async () => {
    const { prisma, incidents } = makeFakePrisma({
      incidents: [],
      members: [
        {
          circleId: "circle_1",
          userId: "observer_1",
          role: "OBSERVER",
          canTriggerIVR: true,
        },
      ],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/trigger-sos",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Forbidden");
      expect(events).toHaveLength(0);
      expect(incidents).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated trigger with 401", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/trigger-sos",
        payload: {},
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// Sanctuary Mode
// --------------------------------------------------------------------------

describe("POST /api/v1/sanctuary", () => {
  it("creates a schedule for the caller within the 14-day cap (R34.1)", async () => {
    const { prisma, sanctuaries } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sanctuary",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: {
          anchorId: "anchor_1",
          startsAt: "2024-01-01T00:00:00.000Z",
          resumesAt: "2024-01-10T00:00:00.000Z",
          reason: "Hospital stay",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        anchorId: "anchor_1",
        isActive: true,
        reason: "Hospital stay",
      });
      expect(sanctuaries).toHaveLength(1);
      expect(sanctuaries[0]!.userId).toBe("anchor_1");
    } finally {
      await app.close();
    }
  });

  it("rejects (400) a window longer than 14 days (R34.1)", async () => {
    const { prisma, sanctuaries } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sanctuary",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: {
          anchorId: "anchor_1",
          startsAt: "2024-01-01T00:00:00.000Z",
          // 15 days later — over the cap.
          resumesAt: "2024-01-16T00:00:01.000Z",
        },
      });

      expect(res.statusCode).toBe(400);
      // Nothing persisted.
      expect(sanctuaries).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("DELETE /api/v1/sanctuary/:id", () => {
  it("deactivates (isActive=false) the caller's schedule", async () => {
    const { prisma, sanctuaries } = makeFakePrisma({
      sanctuaries: [
        {
          id: "sanctuary_1",
          userId: "anchor_1",
          startsAt: new Date("2024-01-01T00:00:00.000Z"),
          resumesAt: new Date("2024-01-05T00:00:00.000Z"),
          reason: null,
          isActive: true,
        },
      ],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/sanctuary/sanctuary_1",
        headers: { authorization: bearer(app, "anchor_1") },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isActive).toBe(false);
      expect(sanctuaries[0]!.isActive).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the schedule belongs to a different user", async () => {
    const { prisma, sanctuaries } = makeFakePrisma({
      sanctuaries: [
        {
          id: "sanctuary_1",
          userId: "someone_else",
          startsAt: new Date("2024-01-01T00:00:00.000Z"),
          resumesAt: new Date("2024-01-05T00:00:00.000Z"),
          reason: null,
          isActive: true,
        },
      ],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/sanctuary/sanctuary_1",
        headers: { authorization: bearer(app, "anchor_1") },
      });

      expect(res.statusCode).toBe(404);
      // Untouched.
      expect(sanctuaries[0]!.isActive).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/sanctuary/active", () => {
  it("lists only the caller's currently-active windows (R34.3)", async () => {
    const now = () => Date.parse("2024-01-03T00:00:00.000Z");
    const { prisma } = makeFakePrisma({
      sanctuaries: [
        {
          id: "active_1",
          userId: "anchor_1",
          startsAt: new Date("2024-01-01T00:00:00.000Z"),
          resumesAt: new Date("2024-01-10T00:00:00.000Z"),
          reason: "travel",
          isActive: true,
        },
        {
          id: "expired_1",
          userId: "anchor_1",
          startsAt: new Date("2023-12-01T00:00:00.000Z"),
          resumesAt: new Date("2023-12-05T00:00:00.000Z"),
          reason: null,
          isActive: true,
        },
        {
          id: "others_1",
          userId: "someone_else",
          startsAt: new Date("2024-01-01T00:00:00.000Z"),
          resumesAt: new Date("2024-01-10T00:00:00.000Z"),
          reason: null,
          isActive: true,
        },
      ],
    });
    const app = await buildTestApp({ prisma, now });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sanctuary/active",
        headers: { authorization: bearer(app, "anchor_1") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ id: string; anchorId: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]!.id).toBe("active_1");
      expect(body[0]!.anchorId).toBe("anchor_1");
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// PUT /medical-dossier
// --------------------------------------------------------------------------

describe("PUT /api/v1/medical-dossier", () => {
  const payloadBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const ivBytes = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]);
  const tagBytes = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));

  function dossierPayload() {
    return {
      encryptedPayload: payloadBytes.toString("base64"),
      iv: ivBytes.toString("base64"),
      authTag: tagBytes.toString("base64"),
      encryptedEmergencyKey: keyBytes.toString("base64"),
    };
  }

  it("stores ciphertext only, base64 -> Bytes verbatim (R33.1, R33.2)", async () => {
    const { prisma, dossiers } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/medical-dossier",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: dossierPayload(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().stored).toBe(true);

      expect(dossiers).toHaveLength(1);
      const row = dossiers[0]!;
      expect(row.userId).toBe("anchor_1");
      // Ciphertext round-trips byte-for-byte.
      expect(row.encryptedPayload.equals(payloadBytes)).toBe(true);
      expect(row.iv.equals(ivBytes)).toBe(true);
      expect(row.authTag.equals(tagBytes)).toBe(true);
      expect(row.encryptedEmergencyKey.equals(keyBytes)).toBe(true);
      // Stored LOCKED — never released on this surface.
      expect(row.accessState).toBe("LOCKED");
    } finally {
      await app.close();
    }
  });

  it("upserts: a second PUT for the same user overwrites the ciphertext", async () => {
    const { prisma, dossiers } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      await app.inject({
        method: "PUT",
        url: "/api/v1/medical-dossier",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: dossierPayload(),
      });

      const newPayload = Buffer.from([0xaa, 0xbb, 0xcc]);
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/medical-dossier",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: {
          ...dossierPayload(),
          encryptedPayload: newPayload.toString("base64"),
        },
      });

      expect(res.statusCode).toBe(200);
      // Still one row (upsert), with the updated ciphertext.
      expect(dossiers).toHaveLength(1);
      expect(dossiers[0]!.encryptedPayload.equals(newPayload)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated dossier upsert with 401", async () => {
    const { prisma, dossiers } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/medical-dossier",
        payload: dossierPayload(),
      });

      expect(res.statusCode).toBe(401);
      expect(dossiers).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

/**
 * Unit tests for the mobile Observer dashboard route (task 21.1 — R15.1-R15.5).
 *
 * Hermetic: a fake Prisma client backs the reads the route performs, so no live
 * DB / Redis is needed. Bearer tokens are minted with the app's own `app.jwt`
 * so the `app.authenticate` guard passes.
 *
 * Coverage:
 *   - ALL_WELL for a calm Anchor with no open incident and an active tier
 *     (R15.1, R15.2), surfacing preferred name + last confirmation time;
 *   - ESCALATING with the current Escalation_Stage for an Anchor with an OPEN
 *     SafetyIncident (R15.3);
 *   - SHIELD_PAUSED for an Anchor whose Circle subscription is paused — takes
 *     precedence over any open incident (R15.1);
 *   - the response DTO carries NO location field (R15.5);
 *   - the route requires auth (401 without a bearer token).
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";

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
// Fake Prisma fixtures.
// --------------------------------------------------------------------------

interface MemberRow {
  circleId: string;
  userId: string;
  role: "ANCHOR" | "OBSERVER" | "MUTUAL";
}

interface UserRow {
  id: string;
  preferredName: string | null;
}

interface SubscriptionRow {
  circleId: string;
  tier: "TRIAL" | "PRO" | "SHIELD_PAUSED";
}

interface IncidentRow {
  circleId: string;
  anchorId: string;
  stage: string;
  status: "OPEN" | "RESOLVED" | "HANDED_OFF_SOS";
  openedAt: Date;
}

interface PulseRow {
  anchorId: string;
  confirmedAt: Date;
}

interface TelemetryRow {
  userId: string;
  screenUnlock: boolean;
  stepDelta: number;
  receivedAt: Date;
}

interface Fixtures {
  members?: MemberRow[];
  users?: UserRow[];
  subscriptions?: SubscriptionRow[];
  incidents?: IncidentRow[];
  pulses?: PulseRow[];
  telemetry?: TelemetryRow[];
}

function inClause(value: unknown): string[] {
  if (value && typeof value === "object" && "in" in (value as object)) {
    return (value as { in: string[] }).in;
  }
  return [];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const members = fixtures.members ?? [];
  const users = fixtures.users ?? [];
  const subscriptions = fixtures.subscriptions ?? [];
  const incidents = fixtures.incidents ?? [];
  const pulses = fixtures.pulses ?? [];
  const telemetry = fixtures.telemetry ?? [];

  const prisma = {
    circleMember: {
      findMany: vi.fn(
        async (args: {
          where: {
            userId?: string | { not?: string };
            circleId?: { in: string[] };
            role?: { in: string[] };
          };
        }) => {
          const where = args.where;
          return members
            .filter((m) => {
              if (typeof where.userId === "string") {
                if (m.userId !== where.userId) return false;
              } else if (where.userId?.not) {
                if (m.userId === where.userId.not) return false;
              }
              if (where.circleId?.in && !where.circleId.in.includes(m.circleId)) {
                return false;
              }
              if (where.role?.in && !where.role.in.includes(m.role)) {
                return false;
              }
              return true;
            })
            .map((m) => ({ circleId: m.circleId, userId: m.userId }));
        },
      ),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = users.find((u) => u.id === args.where.id);
        return row ? { preferredName: row.preferredName } : null;
      }),
    },
    subscription: {
      findMany: vi.fn(
        async (args: { where: { circleId: { in: string[] } } }) => {
          const ids = inClause(args.where.circleId);
          return subscriptions
            .filter((s) => ids.includes(s.circleId))
            .map((s) => ({ circleId: s.circleId, tier: s.tier }));
        },
      ),
    },
    safetyIncident: {
      findFirst: vi.fn(
        async (args: {
          where: { circleId: string; anchorId: string; status: string };
        }) => {
          const { circleId, anchorId, status } = args.where;
          const matches = incidents
            .filter(
              (i) =>
                i.circleId === circleId &&
                i.anchorId === anchorId &&
                i.status === status,
            )
            .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
          const hit = matches[0];
          return hit ? { stage: hit.stage } : null;
        },
      ),
    },
    vitalityPulseLog: {
      findFirst: vi.fn(async (args: { where: { anchorId: string } }) => {
        const matches = pulses
          .filter((p) => p.anchorId === args.where.anchorId)
          .sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime());
        const hit = matches[0];
        return hit ? { confirmedAt: hit.confirmedAt } : null;
      }),
    },
    telemetryLog: {
      findFirst: vi.fn(async (args: { where: { userId: string } }) => {
        const matches = telemetry
          .filter(
            (t) =>
              t.userId === args.where.userId &&
              (t.screenUnlock || t.stepDelta > 0),
          )
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        const hit = matches[0];
        return hit ? { receivedAt: hit.receivedAt } : null;
      }),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma };
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

// --------------------------------------------------------------------------
// GET /observer/dashboard
// --------------------------------------------------------------------------

describe("GET /api/v1/observer/dashboard", () => {
  it("derives ALL_WELL with preferred name + last confirmation (R15.1, R15.2)", async () => {
    const confirmedAt = new Date("2024-03-15T02:30:00.000Z");
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      subscriptions: [{ circleId: "c1", tier: "PRO" }],
      pulses: [{ anchorId: "anchor_1", confirmedAt }],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.anchors).toHaveLength(1);
      expect(body.anchors[0]).toMatchObject({
        anchorId: "anchor_1",
        preferredName: "Amma",
        state: "ALL_WELL",
        lastConfirmationAt: confirmedAt.toISOString(),
      });
      expect(body.anchors[0].escalationStage).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("surfaces the current escalation stage for an OPEN incident (R15.3)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      subscriptions: [{ circleId: "c1", tier: "PRO" }],
      incidents: [
        {
          circleId: "c1",
          anchorId: "anchor_1",
          stage: "STAGE_3_OBSERVER_SILENT_ALERT",
          status: "OPEN",
          openedAt: new Date("2024-03-15T04:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.anchors[0]).toMatchObject({
        anchorId: "anchor_1",
        state: "ESCALATING",
        escalationStage: "STAGE_3_OBSERVER_SILENT_ALERT",
      });
    } finally {
      await app.close();
    }
  });

  it("shows SHIELD_PAUSED which takes precedence over an open incident (R15.1)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      subscriptions: [{ circleId: "c1", tier: "SHIELD_PAUSED" }],
      incidents: [
        {
          circleId: "c1",
          anchorId: "anchor_1",
          stage: "STAGE_4_HYPERLOCAL_DISPATCH",
          status: "OPEN",
          openedAt: new Date("2024-03-15T04:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.anchors[0].state).toBe("SHIELD_PAUSED");
      expect(body.anchors[0].escalationStage).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("uses the later of Vitality Pulse and confirming heartbeat for last confirmation (R15.2)", async () => {
    const pulseAt = new Date("2024-03-15T02:30:00.000Z");
    const heartbeatAt = new Date("2024-03-15T06:45:00.000Z"); // later
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      subscriptions: [{ circleId: "c1", tier: "PRO" }],
      pulses: [{ anchorId: "anchor_1", confirmedAt: pulseAt }],
      telemetry: [
        {
          userId: "anchor_1",
          screenUnlock: true,
          stepDelta: 0,
          receivedAt: heartbeatAt,
        },
      ],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().anchors[0].lastConfirmationAt).toBe(
        heartbeatAt.toISOString(),
      );
    } finally {
      await app.close();
    }
  });

  it("excludes any continuous location trace from the response DTO (R15.5)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      subscriptions: [{ circleId: "c1", tier: "PRO" }],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const anchor = res.json().anchors[0];
      const keys = Object.keys(anchor);
      // No location-bearing field of any kind is present.
      for (const forbidden of [
        "location",
        "lat",
        "lng",
        "latitude",
        "longitude",
        "coords",
        "coordinates",
        "gps",
        "trace",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
      // Only the calm well-being fields are ever present; `escalationStage`
      // and `lastConfirmationAt` are optional and omitted here. The DTO carries
      // no location field of any shape (R15.5).
      const ALLOWED = new Set([
        "anchorId",
        "preferredName",
        "state",
        "escalationStage",
        "lastConfirmationAt",
      ]);
      for (const key of keys) {
        expect(ALLOWED.has(key)).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it("falls back to a neutral label when the Anchor has no preferred name", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: null }],
      subscriptions: [{ circleId: "c1", tier: "TRIAL" }],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const anchor = res.json().anchors[0];
      expect(anchor.preferredName).toBe("Anchor");
      expect(anchor.state).toBe("ALL_WELL");
      expect(anchor.lastConfirmationAt).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("requires authentication — 401 without a bearer token", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/observer/dashboard",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

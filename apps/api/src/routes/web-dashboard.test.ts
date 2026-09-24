/**
 * Unit tests for the web Observer dashboard stream (task 20.2 — R28.5, R28.8,
 * R28.9). Hermetic: a fake Prisma client backs the reads; tokens are minted
 * with the app's own `app.jwt`. The SSE stream is bounded to a single frame via
 * `webDashboardMaxFrames` so `app.inject` returns the accumulated body instead
 * of hanging on an open socket.
 *
 * Coverage:
 *   - SSE emits an initial `snapshot` frame with per-Anchor state + the
 *     dual-timezone tick (R28.5, R28.6, R28.8);
 *   - SHIELD_PAUSED / ESCALATING derivation matches the mobile dashboard;
 *   - the WS-fallback snapshot returns the same DashboardSnapshot shape (R28.9);
 *   - SSE auth accepts `?token=` (EventSource cannot set headers);
 *   - anonymous callers are 401 on both endpoints;
 *   - no location field appears on any tick (R28.15).
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

interface MemberRow {
  circleId: string;
  userId: string;
  role: "ANCHOR" | "OBSERVER" | "MUTUAL";
}
interface UserRow {
  id: string;
  preferredName: string | null;
  timezone?: string;
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

interface Fixtures {
  members?: MemberRow[];
  users?: UserRow[];
  subscriptions?: SubscriptionRow[];
  incidents?: IncidentRow[];
  pulses?: PulseRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const members = fixtures.members ?? [];
  const users = fixtures.users ?? [];
  const subscriptions = fixtures.subscriptions ?? [];
  const incidents = fixtures.incidents ?? [];
  const pulses = fixtures.pulses ?? [];

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
              if (where.circleId?.in && !where.circleId.in.includes(m.circleId))
                return false;
              if (where.role?.in && !where.role.in.includes(m.role))
                return false;
              return true;
            })
            .map((m) => ({ circleId: m.circleId, userId: m.userId }));
        },
      ),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = users.find((u) => u.id === args.where.id);
        return row
          ? { preferredName: row.preferredName, timezone: row.timezone ?? "Asia/Kolkata" }
          : null;
      }),
    },
    subscription: {
      findMany: vi.fn(async (args: { where: { circleId: { in: string[] } } }) => {
        const ids = args.where.circleId.in;
        return subscriptions
          .filter((s) => ids.includes(s.circleId))
          .map((s) => ({ circleId: s.circleId, tier: s.tier }));
      }),
    },
    safetyIncident: {
      findFirst: vi.fn(
        async (args: {
          where: { circleId: string; anchorId: string; status: string };
        }) => {
          const { circleId, anchorId, status } = args.where;
          const hit = incidents
            .filter(
              (i) =>
                i.circleId === circleId &&
                i.anchorId === anchorId &&
                i.status === status,
            )
            .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
          return hit ? { stage: hit.stage } : null;
        },
      ),
    },
    vitalityPulseLog: {
      findFirst: vi.fn(async (args: { where: { anchorId: string } }) => {
        const hit = pulses
          .filter((p) => p.anchorId === args.where.anchorId)
          .sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime())[0];
        return hit ? { confirmedAt: hit.confirmedAt } : null;
      }),
    },
    telemetryLog: {
      findFirst: vi.fn(async () => null),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({
    env: testEnv(),
    loggerEnabled: false,
    // Bound the SSE stream to a single frame so inject() completes.
    webDashboardMaxFrames: 1,
    ...overrides,
  });
}

function bearer(app: FastifyInstance, userId: string): string {
  return `Bearer ${app.jwt.sign({ sub: userId, channel: "WEB" })}`;
}

/** Parse the `data:` payload of the first SSE `snapshot` frame. */
function parseFirstSnapshot(body: string): unknown {
  const dataLine = body
    .split("\n")
    .find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`no data frame in SSE body: ${body}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

/**
 * Read the bounded SSE stream via `app.inject`. The handler streams the SSE
 * body as a Node Readable and, with `webDashboardMaxFrames: 1`, ends it after
 * the first frame — so inject drains the whole body deterministically.
 */
async function readSse(
  app: FastifyInstance,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; contentType: string; body: string }> {
  const res = await app.inject({ method: "GET", url: path, headers });
  return {
    statusCode: res.statusCode,
    contentType: String(res.headers["content-type"] ?? ""),
    body: res.body,
  };
}

describe("GET /api/v1/web/dashboard/stream (SSE)", () => {
  const fixtures: Fixtures = {
    members: [
      { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
      { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
    ],
    users: [{ id: "anchor_1", preferredName: "Amma", timezone: "Asia/Kolkata" }],
    subscriptions: [{ circleId: "c1", tier: "PRO" }],
    pulses: [{ anchorId: "anchor_1", confirmedAt: new Date("2024-03-15T02:30:00.000Z") }],
  };

  it("emits an initial snapshot frame with state + dual-timezone tick (R28.5, R28.6, R28.8)", async () => {
    const { prisma } = makeFakePrisma(fixtures);
    const app = await buildTestApp({
      prisma,
      now: () => Date.parse("2024-03-15T04:00:00.000Z"),
    });
    try {
      const res = await readSse(app, "/api/v1/web/dashboard/stream", {
        authorization: bearer(app, "observer_1"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.contentType).toContain("text/event-stream");
      const snap = parseFirstSnapshot(res.body) as {
        observerTime: string;
        anchors: Array<Record<string, unknown>>;
      };
      expect(snap.observerTime).toBe("2024-03-15T04:00:00.000Z");
      expect(snap.anchors).toHaveLength(1);
      const a = snap.anchors[0]!;
      expect(a.anchorId).toBe("anchor_1");
      expect(a.preferredName).toBe("Amma");
      expect(a.state).toBe("ALL_WELL");
      expect(a.lastConfirmationAt).toBe("2024-03-15T02:30:00.000Z");
      // Dual-timezone tick: Anchor in IST is UTC+5:30 -> 09:30 local.
      expect(a.anchorTimezone).toBe("Asia/Kolkata");
      expect(a.observerTime).toBe("2024-03-15T04:00:00.000Z");
      expect(String(a.anchorTime)).toContain("+05:30");
      expect(String(a.anchorTime)).toContain("T09:30:00");
    } finally {
      await app.close();
    }
  });

  it("surfaces ESCALATING with the active stage (R28.8)", async () => {
    const { prisma } = makeFakePrisma({
      ...fixtures,
      incidents: [
        {
          circleId: "c1",
          anchorId: "anchor_1",
          stage: "STAGE_4_HYPERLOCAL_DISPATCH",
          status: "OPEN",
          openedAt: new Date("2024-03-15T03:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma });
    try {
      const res = await readSse(app, "/api/v1/web/dashboard/stream", {
        authorization: bearer(app, "observer_1"),
      });
      const snap = parseFirstSnapshot(res.body) as {
        anchors: Array<Record<string, unknown>>;
      };
      expect(snap.anchors[0]!.state).toBe("ESCALATING");
      expect(snap.anchors[0]!.escalationStage).toBe("STAGE_4_HYPERLOCAL_DISPATCH");
    } finally {
      await app.close();
    }
  });

  it("accepts the token via ?token= for EventSource clients", async () => {
    const { prisma } = makeFakePrisma(fixtures);
    const app = await buildTestApp({ prisma });
    try {
      const token = app.jwt.sign({ sub: "observer_1", channel: "WEB" });
      const res = await readSse(
        app,
        `/api/v1/web/dashboard/stream?token=${encodeURIComponent(token)}`,
      );
      expect(res.statusCode).toBe(200);
      const snap = parseFirstSnapshot(res.body) as {
        anchors: unknown[];
      };
      expect(snap.anchors).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects an anonymous caller with 401", async () => {
    const { prisma } = makeFakePrisma(fixtures);
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/dashboard/stream",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("emits no location field on any tick (R28.15)", async () => {
    const { prisma } = makeFakePrisma(fixtures);
    const app = await buildTestApp({ prisma });
    try {
      const res = await readSse(app, "/api/v1/web/dashboard/stream", {
        authorization: bearer(app, "observer_1"),
      });
      const snap = parseFirstSnapshot(res.body) as {
        anchors: Array<Record<string, unknown>>;
      };
      const keys = Object.keys(snap.anchors[0]!);
      for (const forbidden of [
        "location",
        "lat",
        "lng",
        "latitude",
        "longitude",
        "coords",
        "gps",
        "trace",
        "breadcrumbs",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/web/dashboard/ws (fallback snapshot)", () => {
  const fixtures: Fixtures = {
    members: [
      { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
      { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
    ],
    users: [{ id: "anchor_1", preferredName: "Amma" }],
    subscriptions: [{ circleId: "c1", tier: "SHIELD_PAUSED" }],
  };

  it("returns the same DashboardSnapshot shape as the SSE frame (R28.9)", async () => {
    const { prisma } = makeFakePrisma(fixtures);
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/dashboard/ws",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.anchors).toHaveLength(1);
      expect(body.anchors[0].state).toBe("SHIELD_PAUSED");
      expect(typeof body.observerTime).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("rejects an anonymous caller with 401", async () => {
    const { prisma } = makeFakePrisma(fixtures);
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/web/dashboard/ws" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/**
 * Integration tests for the admin console API routes (task 19.1 — R21).
 *
 * Hermetic: a fake Prisma client backs the reads/writes each route performs and
 * records every AdminAuditLog row; a fake event emitter captures
 * `subscription.changed` / `incident.retry-dispatch`; the admin session
 * verifier is stubbed so a test can drive any (role, mfa) identity by setting a
 * simple `x-test-admin` header. Injected seams (on-call alerter, wakefulness
 * pinger, purge scheduler, error queue) are captured for assertions.
 *
 * Coverage:
 *   - MFA gate: a non-MFA admin token is rejected 401 (R21.1);
 *   - RBAC allow/deny per role, with an out-of-role attempt producing 403 AND a
 *     SECURITY_VIOLATION audit row (R21.2-R21.5);
 *   - every successful handler writes exactly one AdminAuditLog row (R21.9);
 *   - live incidents mask the anchor phone to last 4 digits (R21.8);
 *   - fleet pulse counts telemetry-at-risk devices (R21.16);
 *   - carrier health fires the on-call alert above 5% (R21.14);
 *   - trial extension restores SHIELD_PAUSED -> TRIAL and emits (R21.19);
 *   - purge-request schedules with a 30-day grace (R21.21);
 *   - wakefulness-test pings the device (R21.18);
 *   - error-queue reads the shared queue (R21.20).
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";
import {
  InMemoryOnCallAlerter,
  InMemoryWakefulnessPinger,
  InMemoryPurgeScheduler,
  PURGE_GRACE_MS,
  CARRIER_ALERT_WINDOW_MS,
  type AdminSession,
  type AdminSessionVerifier,
} from "../services/admin.js";
import { InMemoryAdminErrorQueue } from "../services/subscriptions.js";
import type { AdminRole } from "@kshema/types";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    OTP_SECRET: "test-otp-secret",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0",
    SUBSCRIPTION_WEBHOOK_SECRET: "test-webhook-secret",
    PORT: "0",
  });
}

/**
 * Stub session verifier driven by an `x-test-admin` header of the form
 * `"<adminId>:<role>:<mfa>"`, e.g. `"admin_1:SUPPORT_AGENT:1"`. An empty/absent
 * header yields `null` (no session). This lets each request pick its identity
 * without minting real JWTs.
 */
const stubVerifier: AdminSessionVerifier = {
  verify(bearer: string | undefined): AdminSession | null {
    // The route passes `request.headers.authorization`; we encode the identity
    // there directly as `Admin <id>:<role>:<mfa>`.
    if (!bearer) return null;
    const raw = bearer.startsWith("Admin ")
      ? bearer.slice("Admin ".length)
      : bearer;
    const [adminUserId, role, mfa] = raw.split(":");
    if (!adminUserId || !role) return null;
    return {
      adminUserId,
      role: role as AdminRole,
      mfa: mfa === "1",
    };
  },
};

/** Build the `authorization` header for a given identity. */
function asAdmin(id: string, role: AdminRole, mfa = true): string {
  return `Admin ${id}:${role}:${mfa ? "1" : "0"}`;
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
// Fake Prisma.
// --------------------------------------------------------------------------

interface CircleRow {
  id: string;
}
interface IncidentRow {
  id: string;
  circleId: string;
  anchorId: string;
  stage: string;
  status: string;
  openedAt: Date;
}
interface UserRow {
  id: string;
  phone: string;
  pushTokens?: string[];
}
interface DeviceRow {
  id: string;
  userId: string;
  lastTelemetrySyncAt: Date | null;
}
interface SubscriptionRow {
  id: string;
  circleId: string;
  tier: string;
  trialEndsAt: Date;
}
interface CarrierMetricRow {
  gateway: string;
  errorRate: number | null;
  deliveryLatencyMs: number | null;
  windowStart: Date;
}

interface Fixtures {
  circles?: CircleRow[];
  incidents?: IncidentRow[];
  users?: UserRow[];
  devices?: DeviceRow[];
  subscriptions?: SubscriptionRow[];
  carrierMetrics?: CarrierMetricRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const circles = fixtures.circles ?? [];
  const incidents = fixtures.incidents ?? [];
  const users = fixtures.users ?? [];
  const devices = fixtures.devices ?? [];
  const subscriptions = fixtures.subscriptions ?? [];
  const carrierMetrics = fixtures.carrierMetrics ?? [];
  const auditLogs: Array<Record<string, unknown>> = [];

  const prisma = {
    circle: {
      count: vi.fn(async () => circles.length),
    },
    safetyIncident: {
      count: vi.fn(async (args?: { where?: { status?: string } }) => {
        const status = args?.where?.status;
        return status
          ? incidents.filter((i) => i.status === status).length
          : incidents.length;
      }),
      findMany: vi.fn(async (args?: { where?: { status?: string } }) => {
        const status = args?.where?.status;
        return incidents
          .filter((i) => (status ? i.status === status : true))
          .map((i) => ({ ...i }));
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const i = incidents.find((x) => x.id === args.where.id);
        return i ? { ...i } : null;
      }),
    },
    user: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        return users
          .filter((u) => args.where.id.in.includes(u.id))
          .map((u) => ({ id: u.id, phone: u.phone }));
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const u = users.find((x) => x.id === args.where.id);
        if (!u) return null;
        return { id: u.id, phone: u.phone, pushTokens: u.pushTokens ?? [] };
      }),
    },
    deviceConfig: {
      findMany: vi.fn(async () =>
        devices.map((d) => ({ lastTelemetrySyncAt: d.lastTelemetrySyncAt })),
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const d = devices.find((x) => x.id === args.where.id);
        return d ? { id: d.id, userId: d.userId } : null;
      }),
    },
    subscription: {
      findMany: vi.fn(async () =>
        subscriptions.map((s) => ({
          circleId: s.circleId,
          tier: s.tier,
          trialEndsAt: s.trialEndsAt,
        })),
      ),
      findUnique: vi.fn(async (args: { where: { circleId: string } }) => {
        const s = subscriptions.find((x) => x.circleId === args.where.circleId);
        return s
          ? { id: s.id, tier: s.tier, trialEndsAt: s.trialEndsAt }
          : null;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const s = subscriptions.find((x) => x.id === args.where.id);
          if (s) Object.assign(s, args.data);
          return s ?? null;
        },
      ),
    },
    carrierGatewayMetric: {
      findMany: vi.fn(
        async (args: { where: { windowStart: { gte: Date } } }) => {
          return carrierMetrics
            .filter((m) => m.windowStart >= args.where.windowStart.gte)
            .map((m) => ({ ...m }));
        },
      ),
    },
    adminAuditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        auditLogs.push(args.data);
        return { id: `audit_${auditLogs.length}`, ...args.data };
      }),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, auditLogs, subscriptions };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({
    env: testEnv(),
    loggerEnabled: false,
    adminSessionVerifier: stubVerifier,
    // Default to a fake emitter so tests never touch a live Redis; a test that
    // asserts on emitted events passes its own capturing emitter via overrides.
    eventEmitter: makeFakeEmitter().emitter,
    ...overrides,
  });
}

describe("Admin API — AdminAuthGuard MFA + RBAC (R21.1, R21.5)", () => {
  it("rejects a non-MFA admin token with 401", async () => {
    const { prisma } = makeFakePrisma({ circles: [{ id: "c1" }] });
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/fleet/pulse",
        headers: { authorization: asAdmin("admin_1", "SUPER_ADMIN", false) },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects a missing admin token with 401", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/fleet/pulse",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("denies an out-of-role attempt 403 AND records a SECURITY_VIOLATION (R21.5)", async () => {
    const { prisma, auditLogs } = makeFakePrisma();
    const app = await buildTestApp({ prisma });
    try {
      // BILLING_OPS attempting an operational retry dispatch is out of role.
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/fleet/pulse",
        headers: { authorization: asAdmin("admin_b", "BILLING_OPS") },
      });
      expect(res.statusCode).toBe(403);
      const violations = auditLogs.filter(
        (l) => l.action === "SECURITY_VIOLATION",
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]!.adminUserId).toBe("admin_b");
    } finally {
      await app.close();
    }
  });
});

describe("GET /admin/fleet/pulse (R21.15, R21.16, R21.9)", () => {
  it("counts active circles, telemetry-at-risk devices, and open incidents + audits VIEW", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const { prisma, auditLogs } = makeFakePrisma({
      circles: [{ id: "c1" }, { id: "c2" }],
      incidents: [
        {
          id: "i1",
          circleId: "c1",
          anchorId: "u1",
          stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
          status: "OPEN",
          openedAt: now,
        },
        {
          id: "i2",
          circleId: "c2",
          anchorId: "u2",
          stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
          status: "RESOLVED",
          openedAt: now,
        },
      ],
      devices: [
        // silent > 45m -> at risk
        { id: "d1", userId: "u1", lastTelemetrySyncAt: new Date(now.getTime() - 60 * 60 * 1000) },
        // recent -> healthy
        { id: "d2", userId: "u2", lastTelemetrySyncAt: new Date(now.getTime() - 5 * 60 * 1000) },
        // never synced -> at risk
        { id: "d3", userId: "u3", lastTelemetrySyncAt: null },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => now.getTime() });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/fleet/pulse",
        headers: { authorization: asAdmin("admin_s", "SUPPORT_AGENT") },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        activeCircles: 2,
        telemetryAtRisk: 2,
        openIncidents: 1,
      });
      const views = auditLogs.filter((l) => l.action === "VIEW");
      expect(views).toHaveLength(1);
      expect(views[0]!.targetEntity).toBe("fleet/pulse");
    } finally {
      await app.close();
    }
  });
});

describe("GET /admin/incidents/live — phone masking (R21.8)", () => {
  it("masks the anchor phone to the last 4 digits", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const { prisma } = makeFakePrisma({
      incidents: [
        {
          id: "i1",
          circleId: "c1",
          anchorId: "u1",
          stage: "STAGE_4_HYPERLOCAL_DISPATCH",
          status: "OPEN",
          openedAt: now,
        },
      ],
      users: [{ id: "u1", phone: "+919876543210" }],
    });
    const app = await buildTestApp({ prisma, now: () => now.getTime() });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/incidents/live",
        headers: { authorization: asAdmin("admin_s", "SUPPORT_AGENT") },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json();
      expect(rows).toHaveLength(1);
      expect(rows[0].maskedAnchorPhone).toBe("••••••••3210");
      expect(rows[0].maskedAnchorPhone).not.toContain("98765");
    } finally {
      await app.close();
    }
  });
});

describe("GET /admin/carrier/health — on-call alert (R21.14)", () => {
  it("fires the on-call alert when the rolling error rate exceeds 5%", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const alerter = new InMemoryOnCallAlerter();
    const { prisma } = makeFakePrisma({
      carrierMetrics: [
        {
          gateway: "WHATSAPP",
          errorRate: 0.08,
          deliveryLatencyMs: 220,
          windowStart: new Date(now.getTime() - 5 * 60 * 1000),
        },
        {
          gateway: "TWILIO",
          errorRate: 0.02,
          deliveryLatencyMs: 100,
          windowStart: new Date(now.getTime() - 5 * 60 * 1000),
        },
        // stale sample outside the 15m window — must be excluded
        {
          gateway: "EXOTEL",
          errorRate: 0.9,
          deliveryLatencyMs: 100,
          windowStart: new Date(now.getTime() - CARRIER_ALERT_WINDOW_MS - 60_000),
        },
      ],
    });
    const app = await buildTestApp({
      prisma,
      now: () => now.getTime(),
      adminOnCallAlerter: alerter,
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/carrier/health",
        headers: { authorization: asAdmin("admin_s", "SUPPORT_AGENT") },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json();
      // Only WHATSAPP + TWILIO are within the window.
      expect(rows.map((r: { gateway: string }) => r.gateway).sort()).toEqual([
        "TWILIO",
        "WHATSAPP",
      ]);
      // Exactly one alert fired — for WHATSAPP at 8%.
      expect(alerter.alerts).toHaveLength(1);
      expect(alerter.alerts[0]!.gateway).toBe("WHATSAPP");
      expect(alerter.alerts[0]!.errorRate).toBeCloseTo(0.08);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /admin/circles/:id/trial — trial extension (R21.19)", () => {
  it("restores SHIELD_PAUSED -> TRIAL, extends expiry, emits, and audits with the reason", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const { emitter, events } = makeFakeEmitter();
    const { prisma, auditLogs, subscriptions } = makeFakePrisma({
      subscriptions: [
        {
          id: "s1",
          circleId: "c1",
          tier: "SHIELD_PAUSED",
          trialEndsAt: new Date("2024-05-01T00:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({
      prisma,
      eventEmitter: emitter,
      now: () => now.getTime(),
    });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/admin/circles/c1/trial",
        headers: { authorization: asAdmin("admin_bo", "BILLING_OPS") },
        payload: { additionalDays: 7, justification: "goodwill retention" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.previousTier).toBe("SHIELD_PAUSED");
      expect(body.tier).toBe("TRIAL");
      // Extended 7 days from `now` (since old expiry was in the past).
      expect(new Date(body.trialEndsAt).getTime()).toBe(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      );
      expect(subscriptions[0]!.tier).toBe("TRIAL");
      // Emitted a resume-driving subscription.changed.
      expect(
        events.some(
          (e) =>
            e.name === "subscription.changed" &&
            (e.payload as { to?: string }).to === "TRIAL",
        ),
      ).toBe(true);
      // MUTATION audit carries the reason.
      const mutations = auditLogs.filter((l) => l.action === "MUTATION");
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.justification).toBe("goodwill retention");
    } finally {
      await app.close();
    }
  });

  it("rejects a PRO circle with 400 (no extension needed)", async () => {
    const { prisma } = makeFakePrisma({
      subscriptions: [
        {
          id: "s1",
          circleId: "c1",
          tier: "PRO",
          trialEndsAt: new Date("2024-05-01T00:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/admin/circles/c1/trial",
        headers: { authorization: asAdmin("admin_bo", "BILLING_OPS") },
        payload: { additionalDays: 7, justification: "x" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("POST /admin/users/:id/purge-request — 30-day grace (R21.21)", () => {
  it("schedules a purge 30 days out (SUPER_ADMIN only) and audits", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const scheduler = new InMemoryPurgeScheduler();
    const { prisma, auditLogs } = makeFakePrisma({
      users: [{ id: "u1", phone: "+911111111111" }],
    });
    const app = await buildTestApp({
      prisma,
      now: () => now.getTime(),
      adminPurgeScheduler: scheduler,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/users/u1/purge-request",
        headers: { authorization: asAdmin("admin_sa", "SUPER_ADMIN") },
        payload: { justification: "DPDP erasure request" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.scheduled).toBe(true);
      expect(new Date(body.purgeAfter).getTime()).toBe(
        now.getTime() + PURGE_GRACE_MS,
      );
      expect(scheduler.scheduled).toHaveLength(1);
      expect(scheduler.scheduled[0]!.userId).toBe("u1");
      expect(auditLogs.filter((l) => l.action === "MUTATION")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("denies a SUPPORT_AGENT purge attempt 403 + SECURITY_VIOLATION", async () => {
    const { prisma, auditLogs } = makeFakePrisma({
      users: [{ id: "u1", phone: "+911111111111" }],
    });
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/users/u1/purge-request",
        headers: { authorization: asAdmin("admin_s", "SUPPORT_AGENT") },
        payload: { justification: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect(
        auditLogs.filter((l) => l.action === "SECURITY_VIOLATION"),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("POST /admin/devices/:id/wakefulness-test (R21.18)", () => {
  it("pings the device and audits a MUTATION", async () => {
    const pinger = new InMemoryWakefulnessPinger();
    const { prisma, auditLogs } = makeFakePrisma({
      devices: [{ id: "d1", userId: "u1", lastTelemetrySyncAt: null }],
      users: [{ id: "u1", phone: "+911111111111", pushTokens: ["tok-a"] }],
    });
    const app = await buildTestApp({ prisma, adminWakefulnessPinger: pinger });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/devices/d1/wakefulness-test",
        headers: { authorization: asAdmin("admin_s", "SUPPORT_AGENT") },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deviceId: "d1", pinged: true });
      expect(pinger.pings).toHaveLength(1);
      expect(pinger.pings[0]!.pushTokens).toEqual(["tok-a"]);
      expect(auditLogs.filter((l) => l.action === "MUTATION")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for an unknown device", async () => {
    const { prisma } = makeFakePrisma({ devices: [] });
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/devices/nope/wakefulness-test",
        headers: { authorization: asAdmin("admin_s", "SUPPORT_AGENT") },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("GET /admin/webhooks/error-queue — shared queue (R21.20)", () => {
  it("returns the queued failed webhooks and audits a QUERY", async () => {
    const queue = new InMemoryAdminErrorQueue();
    await queue.push({
      provider: "apple",
      rawBodyBase64: Buffer.from("{}").toString("base64"),
      reason: "Signature verification failed.",
      at: new Date("2024-06-01T00:00:00.000Z").toISOString(),
    });
    const { prisma, auditLogs } = makeFakePrisma();
    const app = await buildTestApp({
      prisma,
      subscriptionErrorQueue: queue,
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/error-queue",
        headers: { authorization: asAdmin("admin_bo", "BILLING_OPS") },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json();
      expect(rows).toHaveLength(1);
      expect(rows[0].provider).toBe("apple");
      expect(auditLogs.filter((l) => l.action === "QUERY")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

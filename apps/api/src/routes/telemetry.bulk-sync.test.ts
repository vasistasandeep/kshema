/**
 * Unit tests for `POST /api/v1/telemetry/bulk-sync` (task 5.2 — R24.2, R24.3,
 * R4.1).
 *
 * Hermetic: a fake Prisma client stores telemetry / ghost rows in memory and a
 * fake DeviceConfig row records `lastTelemetrySyncAt`; a fake event emitter
 * captures emitted domain events. No live DB / Redis needed. Bearer tokens are
 * minted with the app's own `app.jwt` so the `app.authenticate` guard passes.
 *
 * Coverage:
 *   - idempotent resend produces no duplicate TelemetryLog rows (R24.2);
 *   - an in-window heartbeat is admitted to the baseline (status `admitted`,
 *     `telemetry.received` emitted) (R24.3, R4.1);
 *   - a future-dated (> +2m) and a stale (< -7d) heartbeat are flagged
 *     `clock_skew`, still persisted, and NOT emitted for the baseline (R24.3,
 *     R4.1);
 *   - `lastTelemetrySyncAt` on DeviceConfig is updated (R24.3);
 *   - duplicates within a single batch collapse to one row;
 *   - the route requires auth (401 without a bearer token).
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

interface EmittedEvent {
  name: SentinelEventName;
  payload: unknown;
}

function makeRecordingEmitter(sink: EmittedEvent[]): EventEmitter {
  return {
    emit: vi.fn(async (name: SentinelEventName, payload: unknown) => {
      sink.push({ name, payload });
    }),
    close: vi.fn(async () => undefined),
  };
}

interface FakeTelemetryRow {
  id: string;
  userId: string;
  screenUnlock: boolean;
  stepDelta: number;
  batteryLevel: number | null;
  chargerState: string | null;
  capturedAt: Date;
  receivedAt: Date;
}

interface FakeGhostRow {
  id: string;
  userId: string;
  signalType: string;
  source: string | null;
  detectedAt: Date;
}

interface FakeDeviceConfigRow {
  id: string;
  userId: string;
  lastTelemetrySyncAt: Date | null;
}

/**
 * Fake Prisma covering the surfaces bulk-sync uses: `telemetryLog.findMany` /
 * `.create`, `ghostSignalLog.findFirst` / `.create`, and
 * `deviceConfig.updateMany`. A seed DeviceConfig row is created for `user_1`.
 */
function makeFakePrisma() {
  const telemetry: FakeTelemetryRow[] = [];
  const ghosts: FakeGhostRow[] = [];
  const deviceConfigs: FakeDeviceConfigRow[] = [
    { id: "dc_1", userId: "user_1", lastTelemetrySyncAt: null },
  ];
  let seq = 0;
  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}_${seq}`;
  };

  const prisma = {
    telemetryLog: {
      findMany: vi.fn(
        async (args: {
          where: { userId: string; capturedAt: { in: Date[] } };
          select?: unknown;
        }) => {
          const wanted = new Set(
            args.where.capturedAt.in.map((d) => d.toISOString()),
          );
          return telemetry
            .filter(
              (r) =>
                r.userId === args.where.userId &&
                wanted.has(r.capturedAt.toISOString()),
            )
            .map((r) => ({ capturedAt: r.capturedAt }));
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            userId: string;
            screenUnlock: boolean;
            stepDelta: number;
            batteryLevel?: number;
            chargerState?: string;
            capturedAt: Date;
          };
        }) => {
          const row: FakeTelemetryRow = {
            id: nextId("telemetry"),
            userId: args.data.userId,
            screenUnlock: args.data.screenUnlock,
            stepDelta: args.data.stepDelta,
            batteryLevel: args.data.batteryLevel ?? null,
            chargerState: args.data.chargerState ?? null,
            capturedAt: args.data.capturedAt,
            receivedAt: new Date("2024-01-01T00:00:00.000Z"),
          };
          telemetry.push(row);
          return row;
        },
      ),
    },
    ghostSignalLog: {
      findFirst: vi.fn(
        async (args: {
          where: { userId: string; signalType: string; detectedAt: Date };
        }) => {
          const found = ghosts.find(
            (g) =>
              g.userId === args.where.userId &&
              g.signalType === args.where.signalType &&
              g.detectedAt.toISOString() ===
                args.where.detectedAt.toISOString(),
          );
          return found ? { id: found.id } : null;
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            userId: string;
            signalType: string;
            source?: string;
            detectedAt: Date;
          };
        }) => {
          const row: FakeGhostRow = {
            id: nextId("ghost"),
            userId: args.data.userId,
            signalType: args.data.signalType,
            source: args.data.source ?? null,
            detectedAt: args.data.detectedAt,
          };
          ghosts.push(row);
          return row;
        },
      ),
    },
    deviceConfig: {
      updateMany: vi.fn(
        async (args: {
          where: { userId: string };
          data: { lastTelemetrySyncAt: Date };
        }) => {
          let count = 0;
          for (const dc of deviceConfigs) {
            if (dc.userId === args.where.userId) {
              dc.lastTelemetrySyncAt = args.data.lastTelemetrySyncAt;
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, telemetry, ghosts, deviceConfigs };
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

/** A heartbeat captured `deltaMs` from the given base instant. */
function heartbeatAt(iso: string, stepDelta = 10) {
  return {
    deviceId: "device-abc",
    screenUnlocks: ["2024-01-01T06:30:00.000Z"],
    stepDelta,
    battery: 90,
    chargerState: "UNPLUGGED" as const,
    capturedAt: iso,
  };
}

describe("POST /api/v1/telemetry/bulk-sync", () => {
  it("is idempotent: resending the same batch creates no duplicate rows (R24.2)", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    // Use a capturedAt near "now" so it lands inside the clock-skew window.
    const now = new Date();
    const capturedAt = new Date(now.getTime() - 60_000).toISOString();
    const payload = {
      deviceId: "device-abc",
      heartbeats: [heartbeatAt(capturedAt)],
      ghostSignals: [],
    };

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        headers: { authorization: bearer(app, "user_1") },
        payload,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().accepted).toBe(1);
      expect(telemetry).toHaveLength(1);

      // Resend the identical batch.
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        headers: { authorization: bearer(app, "user_1") },
        payload,
      });
      expect(second.statusCode).toBe(200);
      const body = second.json();
      expect(body.accepted).toBe(0);
      expect(body.duplicates).toBe(1);
      expect(body.results[0].status).toBe("duplicate");

      // No new row was written on the resend.
      expect(telemetry).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("admits an in-window heartbeat to the baseline and emits telemetry.received (R24.3, R4.1)", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    const capturedAt = new Date(Date.now() - 30_000).toISOString();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          heartbeats: [heartbeatAt(capturedAt)],
          ghostSignals: [],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(1);
      expect(body.clockSkewFlagged).toBe(0);
      expect(body.results[0].status).toBe("admitted");
      expect(typeof body.results[0].id).toBe("string");

      expect(telemetry).toHaveLength(1);
      const emitted = events.filter((e) => e.name === "telemetry.received");
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({ userId: "user_1" });
    } finally {
      await app.close();
    }
  });

  it("flags future-dated and stale heartbeats as clock_skew, persists them, and excludes them from the baseline (R24.3, R4.1)", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    const now = Date.now();
    // > receivedAt + 2 minutes (10 minutes in the future).
    const future = new Date(now + 10 * 60_000).toISOString();
    // < receivedAt - 7 days (8 days in the past).
    const stale = new Date(now - 8 * 24 * 60 * 60_000).toISOString();
    // In-window control.
    const good = new Date(now - 60_000).toISOString();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          heartbeats: [
            heartbeatAt(future),
            heartbeatAt(stale),
            heartbeatAt(good),
          ],
          ghostSignals: [],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(1); // only `good`
      expect(body.clockSkewFlagged).toBe(2); // future + stale

      const byCaptured = new Map<string, string>(
        body.results.map((r: { capturedAt: string; status: string }) => [
          r.capturedAt,
          r.status,
        ]),
      );
      expect(byCaptured.get(new Date(future).toISOString())).toBe("clock_skew");
      expect(byCaptured.get(new Date(stale).toISOString())).toBe("clock_skew");
      expect(byCaptured.get(new Date(good).toISOString())).toBe("admitted");

      // All three are persisted (out-of-window rows are still stored)...
      expect(telemetry).toHaveLength(3);
      // ...but only the admitted one feeds the rhythm baseline.
      const emitted = events.filter((e) => e.name === "telemetry.received");
      expect(emitted).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("updates DeviceConfig.lastTelemetrySyncAt (R24.3)", async () => {
    const { prisma, deviceConfigs } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    expect(deviceConfigs[0]?.lastTelemetrySyncAt).toBeNull();
    const capturedAt = new Date(Date.now() - 30_000).toISOString();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          heartbeats: [heartbeatAt(capturedAt)],
          ghostSignals: [],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(deviceConfigs[0]?.lastTelemetrySyncAt).not.toBeNull();
      // Response echoes the same sync instant.
      expect(deviceConfigs[0]?.lastTelemetrySyncAt?.toISOString()).toBe(
        body.lastTelemetrySyncAt,
      );
    } finally {
      await app.close();
    }
  });

  it("collapses duplicate capturedAt values within a single batch to one row", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    const capturedAt = new Date(Date.now() - 30_000).toISOString();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          heartbeats: [heartbeatAt(capturedAt), heartbeatAt(capturedAt)],
          ghostSignals: [],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(1);
      expect(body.duplicates).toBe(1);
      expect(telemetry).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated bulk-sync with 401", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/bulk-sync",
        payload: {
          deviceId: "device-abc",
          heartbeats: [],
          ghostSignals: [],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(telemetry).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

/**
 * Unit tests for the telemetry & ghost-signal ingestion routes (task 5.1).
 *
 * All hermetic: a fake Prisma client captures the persisted rows and a fake
 * event emitter records the emitted domain events, so no live DB / Redis is
 * needed. Bearer tokens are minted with the app's own `app.jwt` so the
 * `app.authenticate` guard passes.
 *
 * Coverage:
 *   - `POST /telemetry/heartbeat` persists a TelemetryLog for the authenticated
 *     user and emits `telemetry.received` (R5.1, R5.2, R5.3).
 *   - `POST /telemetry/ghost-signal` persists a GhostSignalLog and emits
 *     `ghost.received` (R6.2, R6.3).
 *   - both routes require auth (401 without a bearer token).
 *   - privacy: the persisted heartbeat payload carries no location field
 *     (R5.5, R19.1).
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

/**
 * Minimal fake Prisma covering the two surfaces the telemetry routes use:
 * `telemetryLog.create` and `ghostSignalLog.create`. Both capture exactly the
 * `data` they were handed so tests can assert on the persisted shape.
 */
function makeFakePrisma() {
  const telemetry: FakeTelemetryRow[] = [];
  const ghosts: FakeGhostRow[] = [];
  let seq = 0;
  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}_${seq}`;
  };

  const prisma = {
    telemetryLog: {
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
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, telemetry, ghosts };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({
    env: testEnv(),
    loggerEnabled: false,
    ...overrides,
  });
}

/** Mint a bearer token accepted by `app.authenticate`. */
function bearer(app: FastifyInstance, userId: string): string {
  const token = app.jwt.sign({ sub: userId, channel: "MOBILE" });
  return `Bearer ${token}`;
}

describe("POST /api/v1/telemetry/heartbeat", () => {
  it("persists a TelemetryLog for the authenticated user and emits telemetry.received", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/heartbeat",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          screenUnlocks: ["2024-01-01T06:30:00.000Z"],
          stepDelta: 42,
          battery: 88,
          chargerState: "UNPLUGGED",
          capturedAt: "2024-01-01T06:31:00.000Z",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.id).toBe("string");
      expect(typeof body.receivedAt).toBe("string");

      // Persisted for the authenticated user, with fields mapped correctly.
      expect(telemetry).toHaveLength(1);
      const row = telemetry[0];
      expect(row?.userId).toBe("user_1");
      expect(row?.screenUnlock).toBe(true);
      expect(row?.stepDelta).toBe(42);
      expect(row?.batteryLevel).toBe(88);
      expect(row?.chargerState).toBe("UNPLUGGED");

      // Emitted the domain event with the log id + user.
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe("telemetry.received");
      expect(events[0]?.payload).toMatchObject({
        telemetryLogId: row?.id,
        userId: "user_1",
      });
    } finally {
      await app.close();
    }
  });

  it("records screenUnlock=false when no unlock events are present", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/heartbeat",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          screenUnlocks: [],
          stepDelta: 0,
          capturedAt: "2024-01-01T06:31:00.000Z",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(telemetry[0]?.screenUnlock).toBe(false);
      expect(telemetry[0]?.batteryLevel).toBeNull();
      expect(telemetry[0]?.chargerState).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated heartbeat with 401", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/heartbeat",
        payload: {
          deviceId: "device-abc",
          screenUnlocks: [],
          stepDelta: 0,
          capturedAt: "2024-01-01T06:31:00.000Z",
        },
      });

      expect(res.statusCode).toBe(401);
      // Nothing persisted, nothing emitted.
      expect(telemetry).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("(privacy) persists no location field on the heartbeat row (R5.5)", async () => {
    const { prisma } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/heartbeat",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          screenUnlocks: ["2024-01-01T06:30:00.000Z"],
          stepDelta: 42,
          battery: 88,
          chargerState: "UNPLUGGED",
          capturedAt: "2024-01-01T06:31:00.000Z",
        },
      });
      expect(res.statusCode).toBe(200);

      // The exact `data` handed to Prisma must carry no location/GPS key.
      const createMock = (prisma as unknown as {
        telemetryLog: { create: ReturnType<typeof vi.fn> };
      }).telemetryLog.create;
      const persistedData = createMock.mock.calls[0]?.[0]?.data as Record<
        string,
        unknown
      >;
      const bannedKeys = [
        "location",
        "lat",
        "latitude",
        "lng",
        "longitude",
        "gps",
        "coordinates",
        "coords",
      ];
      for (const key of Object.keys(persistedData)) {
        expect(bannedKeys).not.toContain(key.toLowerCase());
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a heartbeat carrying a location field with 400 (strict schema)", async () => {
    const { prisma, telemetry } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/heartbeat",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          deviceId: "device-abc",
          screenUnlocks: [],
          stepDelta: 0,
          capturedAt: "2024-01-01T06:31:00.000Z",
          location: { lat: 12.9, lng: 77.6 },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(telemetry).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/telemetry/ghost-signal", () => {
  it("persists a GhostSignalLog and emits ghost.received", async () => {
    const { prisma, ghosts } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/ghost-signal",
        headers: { authorization: bearer(app, "user_1") },
        payload: {
          signalType: "MEDIA_DEVICE_WAKE",
          source: "living-room-tv",
          detectedAt: "2024-01-01T06:45:00.000Z",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.id).toBe("string");
      expect(typeof body.receivedAt).toBe("string");

      expect(ghosts).toHaveLength(1);
      const row = ghosts[0];
      expect(row?.userId).toBe("user_1");
      expect(row?.signalType).toBe("MEDIA_DEVICE_WAKE");
      expect(row?.source).toBe("living-room-tv");

      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe("ghost.received");
      expect(events[0]?.payload).toMatchObject({
        ghostSignalLogId: row?.id,
        userId: "user_1",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated ghost signal with 401", async () => {
    const { prisma, ghosts } = makeFakePrisma();
    const events: EmittedEvent[] = [];
    const app = await buildTestApp({
      prisma,
      eventEmitter: makeRecordingEmitter(events),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/ghost-signal",
        payload: {
          signalType: "HOME_WIFI_REASSOCIATION",
          detectedAt: "2024-01-01T06:45:00.000Z",
        },
      });

      expect(res.statusCode).toBe(401);
      expect(ghosts).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

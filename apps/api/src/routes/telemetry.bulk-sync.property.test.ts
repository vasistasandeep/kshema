// Feature: kshema-safety-platform, Property 11: Bulk-sync reconciliation is
// idempotent. For all sets of buffered heartbeats delivered as arbitrarily
// overlapping / retried batches, the final stored telemetry set SHALL equal the
// deduplicated union keyed on (deviceId, capturedAt), independent of batch
// partitioning or ordering.
//
// SCHEMA NOTE (mirrors the route in telemetry.ts): TelemetryLog has no deviceId
// column and every row is written for the authenticated user, so the effective
// idempotency key reduces to (userId, capturedAt). All heartbeats in this test
// are sent by a single authenticated user over a single deviceId, so the
// dedup key is (userId, capturedAt).
/**
 * Property-based test for `POST /api/v1/telemetry/bulk-sync` (task 5.3).
 *
 * Validates: Requirements 24.2, 24.3
 *
 * Uses the same hermetic fake-Prisma + `app.inject` harness style as
 * `telemetry.bulk-sync.test.ts` (copied here so this property test is
 * self-contained and does not depend on the unit test's non-exported helpers).
 * The fake Prisma keeps persisted TelemetryLog rows in memory so the property
 * can inspect the exact persisted set after each sequence of batch injections.
 *
 * Two properties are asserted across ≥100 fast-check iterations:
 *   1. Idempotency (R24.2): sending a batch once, then AGAIN, then a THIRD
 *      time, persists exactly the same set of rows as sending it once — a
 *      resend creates no new rows.
 *   2. Union / partition-independence (R24.2, R24.3): sending an arbitrary
 *      partition of heartbeats as a sequence of overlapping batches persists
 *      exactly the distinct (userId, capturedAt) rows of the union of all
 *      batches, regardless of how the heartbeats are split or ordered.
 */
import fc from "fast-check";
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
 * (Copied from telemetry.bulk-sync.test.ts so this file is independent.)
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

const DEVICE_ID = "device-abc";

/** A heartbeat payload captured at the given ISO instant. */
function heartbeatAt(iso: string, stepDelta: number) {
  return {
    deviceId: DEVICE_ID,
    screenUnlocks: ["2024-01-01T06:30:00.000Z"],
    stepDelta,
    battery: 90,
    chargerState: "UNPLUGGED" as const,
    capturedAt: iso,
  };
}

interface GeneratedHeartbeat {
  capturedAt: string; // ISO
  stepDelta: number;
}

/** Inject one bulk-sync batch and return the parsed response. */
async function postBatch(
  app: FastifyInstance,
  userId: string,
  heartbeats: GeneratedHeartbeat[],
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/telemetry/bulk-sync",
    headers: { authorization: bearer(app, userId) },
    payload: {
      deviceId: DEVICE_ID,
      heartbeats: heartbeats.map((h) => heartbeatAt(h.capturedAt, h.stepDelta)),
      ghostSignals: [],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** The set of distinct (userId, capturedAt) keys persisted in the fake store. */
function persistedKeys(telemetry: FakeTelemetryRow[]): Set<string> {
  return new Set(
    telemetry.map((r) => `${r.userId}\u0000${r.capturedAt.toISOString()}`),
  );
}

// -- Generators -------------------------------------------------------------

// A pool of distinct capturedAt instants near "now" so admission-window
// behaviour is exercised realistically; the property holds regardless of
// window (both admitted and clock-skew rows persist), but keeping them near
// now keeps the batches representative of real reconnect flushes. Instants are
// drawn as whole-second offsets in [-3 days, +1 minute] from a fixed base so
// ISO strings are stable and duplicates are meaningful.
const baseNow = () => Date.now();

function isoFromOffsetSec(offsetSec: number): string {
  return new Date(baseNow() + offsetSec * 1000).toISOString();
}

// Offsets: mostly in-window (within [-7d, +2m]); a few pushed out-of-window to
// prove clock-skew rows are still persisted and still deduplicated.
const offsetSecArb = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: -3 * 24 * 3600, max: 60 }) },
  // out-of-window: far future / far past
  { weight: 1, arbitrary: fc.integer({ min: 10 * 60, max: 60 * 60 }) },
  { weight: 1, arbitrary: fc.integer({ min: -30 * 24 * 3600, max: -8 * 24 * 3600 }) },
);

const heartbeatArb = fc.record({
  offsetSec: offsetSecArb,
  stepDelta: fc.integer({ min: 0, max: 500 }),
});

// A batch is a (possibly empty) list of heartbeats; capturedAt collisions
// within and across batches are the whole point, so we do NOT dedup the pool.
const batchArb = fc.array(heartbeatArb, { minLength: 0, maxLength: 6 });

function toHeartbeats(
  batch: { offsetSec: number; stepDelta: number }[],
): GeneratedHeartbeat[] {
  return batch.map((h) => ({
    capturedAt: isoFromOffsetSec(h.offsetSec),
    stepDelta: h.stepDelta,
  }));
}

// ---------------------------------------------------------------------------

describe("POST /api/v1/telemetry/bulk-sync — Property 11 (R24.2, R24.3)", () => {
  it("is idempotent: resending the same batch two more times persists no new rows", async () => {
    await fc.assert(
      fc.asyncProperty(batchArb, async (rawBatch) => {
        const { prisma, telemetry } = makeFakePrisma();
        const events: EmittedEvent[] = [];
        const app = await buildTestApp({
          prisma,
          eventEmitter: makeRecordingEmitter(events),
        });
        try {
          const heartbeats = toHeartbeats(rawBatch);

          await postBatch(app, "user_1", heartbeats);
          const afterFirst = persistedKeys(telemetry);

          // The first send must persist exactly the distinct capturedAt values.
          const expected = new Set(
            heartbeats.map((h) => `user_1\u0000${h.capturedAt}`),
          );
          expect(afterFirst).toEqual(expected);

          // Resend the identical batch twice more.
          await postBatch(app, "user_1", heartbeats);
          await postBatch(app, "user_1", heartbeats);

          // No new rows: the persisted key set is unchanged and the row count
          // equals the number of distinct keys (no physical duplicates).
          expect(persistedKeys(telemetry)).toEqual(afterFirst);
          expect(telemetry).toHaveLength(afterFirst.size);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it("persists exactly the deduplicated union of overlapping batches, independent of partitioning/ordering", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A sequence of 1..4 arbitrarily overlapping batches.
        fc.array(batchArb, { minLength: 1, maxLength: 4 }),
        async (rawBatches) => {
          const { prisma, telemetry } = makeFakePrisma();
          const events: EmittedEvent[] = [];
          const app = await buildTestApp({
            prisma,
            eventEmitter: makeRecordingEmitter(events),
          });
          try {
            const batches = rawBatches.map(toHeartbeats);

            // Send every batch in sequence (batches may repeat capturedAt
            // values within themselves and across each other).
            for (const batch of batches) {
              await postBatch(app, "user_1", batch);
            }

            // Expected persisted set = distinct (userId, capturedAt) across the
            // union of all heartbeats sent.
            const expected = new Set(
              batches
                .flat()
                .map((h) => `user_1\u0000${h.capturedAt}`),
            );

            expect(persistedKeys(telemetry)).toEqual(expected);
            // No physical duplicates: one row per distinct key.
            expect(telemetry).toHaveLength(expected.size);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 120 },
    );
  }, 120_000);
});

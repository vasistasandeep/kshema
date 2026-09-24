// Feature: kshema-safety-platform, Property 27: Clock-skew heartbeats are excluded from the rhythm baseline
/**
 * Property test for `POST /api/v1/telemetry/bulk-sync` (task 5.4 — Property 27).
 *
 * **Validates: Requirements 24.2, 24.3, 4.1**
 *
 * Property 27 (design.md): for all buffered heartbeats delivered via
 * `bulk-sync` with arbitrary `capturedAt` relative to server `receivedAt`, a
 * heartbeat is admitted to the 14-day Bayesian rhythm baseline IFF
 * `capturedAt <= receivedAt + 2m` AND `capturedAt >= receivedAt - 7d`; every
 * heartbeat outside that window is flagged clock-skew and EXCLUDED from the
 * baseline sample, so the baseline cannot be corrupted by device clock drift.
 *
 * The baseline-admission signal is the `telemetry.received` event, emitted by
 * the route ONLY for admitted heartbeats. This test therefore asserts, over
 * arbitrary batches of heartbeats whose `capturedAt` offsets are drawn from
 * classes spanning well inside the window, just inside / just outside the +2m
 * future and -7d past boundaries, and far outside on both sides:
 *
 *   (1) a `telemetry.received` event is emitted for a heartbeat IFF its
 *       `capturedAt` is within `[receivedAt - 7d, receivedAt + 2m]`;
 *   (2) out-of-window heartbeats are still PERSISTED (a TelemetryLog row is
 *       created) but never emitted (excluded from the baseline);
 *   (3) the per-heartbeat response status (`admitted` vs `clock_skew`) agrees
 *       with the emitted-signal decision.
 *
 * Hermetic: reuses the fake-Prisma + recording event-emitter harness style
 * from telemetry.bulk-sync.test.ts. No live DB / Redis. Min 100 iterations.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";

/** Admission window bounds relative to server `receivedAt` (must mirror the route). */
const FUTURE_MS = 2 * 60 * 1000; // +2 minutes
const PAST_MS = 7 * 24 * 60 * 60 * 1000; // -7 days

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
 * Fake Prisma covering the surfaces bulk-sync uses. Returns the row arrays so
 * the property body can assert that out-of-window heartbeats are still
 * persisted even though they are excluded from the baseline.
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
      findFirst: vi.fn(async () => null),
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

/**
 * A guard band that keeps every generated offset clear of the exact window
 * edge by at least this many milliseconds. The oracle bases its expectation on
 * `Date.now()` captured *before* the request, while the route computes its own
 * `receivedAt` a few milliseconds later (request/inject latency). An offset
 * within that jitter of a boundary could legitimately land on either side, so
 * we probe "just inside" / "just outside" from `GUARD_MS` away rather than at
 * ±1ms. `GUARD_MS` (30s) dwarfs any plausible in-process request latency while
 * remaining a tight boundary probe relative to the 2m / 7d window.
 */
const GUARD_MS = 30 * 1000;

/**
 * Offset classes (milliseconds relative to a batch base instant) that probe the
 * admission window on both boundaries: deep inside, just inside/outside the +2m
 * future edge, just inside/outside the -7d past edge, and far outside on both
 * sides. Each boundary class stays `GUARD_MS` clear of the exact edge so the
 * base-vs-receivedAt jitter cannot flip its classification. `arbitraryOffset`
 * picks a class then a concrete offset within it so fast-check can shrink
 * toward the boundaries.
 */
const arbitraryOffset: fc.Arbitrary<number> = fc.oneof(
  // Well inside the window.
  fc.integer({ min: -PAST_MS + GUARD_MS, max: FUTURE_MS - GUARD_MS }),
  // Just inside the future edge (a short span ending GUARD_MS before +2m).
  fc.integer({ min: FUTURE_MS - 5 * GUARD_MS, max: FUTURE_MS - GUARD_MS }),
  // Just outside the future edge (starting GUARD_MS past +2m).
  fc.integer({ min: FUTURE_MS + GUARD_MS, max: FUTURE_MS + 10 * 60 * 1000 }),
  // Just inside the past edge (a short span ending GUARD_MS after -7d).
  fc.integer({ min: -PAST_MS + GUARD_MS, max: -PAST_MS + 5 * GUARD_MS }),
  // Just outside the past edge (starting GUARD_MS before -7d).
  fc.integer({ min: -PAST_MS - 24 * 60 * 60 * 1000, max: -PAST_MS - GUARD_MS }),
  // Far in the future (well beyond +2m).
  fc.integer({ min: FUTURE_MS + 60 * 60 * 1000, max: 30 * 24 * 60 * 60 * 1000 }),
  // Far in the past (well before -7d).
  fc.integer({
    min: -(365 * 24 * 60 * 60 * 1000),
    max: -PAST_MS - 60 * 60 * 1000,
  }),
);

interface GenHeartbeat {
  offsetMs: number;
  stepDelta: number;
  battery: number;
}

const arbitraryHeartbeat: fc.Arbitrary<GenHeartbeat> = fc.record({
  offsetMs: arbitraryOffset,
  stepDelta: fc.integer({ min: 0, max: 500 }),
  battery: fc.integer({ min: 0, max: 100 }),
});

describe("Property 27: clock-skew heartbeats are excluded from the rhythm baseline", () => {
  it("emits telemetry.received IFF capturedAt is within [now-7d, now+2m]; out-of-window heartbeats are persisted but never emitted", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Distinct offsets keep every capturedAt unique so nothing collapses to
        // a within-batch `duplicate` (which is orthogonal to admission).
        fc
          .uniqueArray(arbitraryHeartbeat, {
            minLength: 1,
            maxLength: 8,
            selector: (h) => h.offsetMs,
          }),
        async (generated) => {
          const { prisma, telemetry } = makeFakePrisma();
          const events: EmittedEvent[] = [];
          const app = await buildTestApp({
            prisma,
            eventEmitter: makeRecordingEmitter(events),
          });

          try {
            // The `capturedAt` timestamps are laid out at fixed offsets from a
            // pre-request `base`. The route, however, judges admission against
            // its OWN `receivedAt = new Date()` computed inside the handler —
            // which may be well after `base` when the event loop is busy under
            // parallel test load. To keep the oracle exact (not timing-
            // dependent), we DO NOT assume base == receivedAt: the route echoes
            // its `receivedAt` verbatim as `lastTelemetrySyncAt`, so we
            // recompute admission against that authoritative instant. The
            // GUARD_MS spacing of the boundary classes guarantees the
            // classification is unambiguous even after re-anchoring.
            const base = Date.now();
            const heartbeats = generated.map((h) => ({
              deviceId: "device-abc",
              screenUnlocks: ["2024-01-01T06:30:00.000Z"],
              stepDelta: h.stepDelta,
              battery: h.battery,
              chargerState: "UNPLUGGED" as const,
              capturedAt: new Date(base + h.offsetMs).toISOString(),
            }));

            const res = await app.inject({
              method: "POST",
              url: "/api/v1/telemetry/bulk-sync",
              headers: { authorization: bearer(app, "user_1") },
              payload: { deviceId: "device-abc", heartbeats, ghostSignals: [] },
            });

            expect(res.statusCode).toBe(200);
            const body = res.json() as {
              accepted: number;
              clockSkewFlagged: number;
              lastTelemetrySyncAt: string;
              results: { capturedAt: string; status: string; id?: string }[];
            };

            // Oracle anchored on the route's actual `receivedAt` (mirrors the
            // route's own `isWithinClockSkewWindow`): admitted IFF
            // capturedAt in [receivedAt - 7d, receivedAt + 2m].
            const receivedAtMs = new Date(body.lastTelemetrySyncAt).getTime();
            const expectedAdmittedIso = new Set<string>();
            const expectedSkewIso = new Set<string>();
            for (const h of generated) {
              const capturedMs = base + h.offsetMs;
              const iso = new Date(capturedMs).toISOString();
              const within =
                capturedMs <= receivedAtMs + FUTURE_MS &&
                capturedMs >= receivedAtMs - PAST_MS;
              if (within) expectedAdmittedIso.add(iso);
              else expectedSkewIso.add(iso);
            }

            const statusByIso = new Map(
              body.results.map((r) => [r.capturedAt, r.status]),
            );

            // (3) Response status agrees with the admission oracle.
            for (const iso of expectedAdmittedIso) {
              expect(statusByIso.get(iso)).toBe("admitted");
            }
            for (const iso of expectedSkewIso) {
              expect(statusByIso.get(iso)).toBe("clock_skew");
            }

            // (2) Every heartbeat is persisted — in and out of window alike.
            expect(telemetry).toHaveLength(generated.length);
            const persistedIso = new Set(
              telemetry.map((r) => r.capturedAt.toISOString()),
            );
            for (const iso of expectedSkewIso) {
              expect(persistedIso.has(iso)).toBe(true);
            }

            // (1) `telemetry.received` — the baseline-admission signal — is
            // emitted IFF the heartbeat is within the window.
            const emittedLogIds = new Set(
              events
                .filter((e) => e.name === "telemetry.received")
                .map((e) => (e.payload as { telemetryLogId: string })
                  .telemetryLogId),
            );
            // Map admitted result ids back and confirm each got an emit.
            const admittedIds = body.results
              .filter((r) => r.status === "admitted")
              .map((r) => r.id as string);
            const skewIds = body.results
              .filter((r) => r.status === "clock_skew")
              .map((r) => r.id as string);

            expect(emittedLogIds.size).toBe(expectedAdmittedIso.size);
            for (const id of admittedIds) {
              expect(emittedLogIds.has(id)).toBe(true);
            }
            // Out-of-window rows exist but are excluded from the baseline.
            for (const id of skewIds) {
              expect(emittedLogIds.has(id)).toBe(false);
            }

            // Aggregate counts also line up with the oracle.
            expect(body.accepted).toBe(expectedAdmittedIso.size);
            expect(body.clockSkewFlagged).toBe(expectedSkewIso.size);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
    // Each of the 100 runs builds a full Fastify app, injects a request, and
    // closes it. That is inherently slow (the property body alone is ~2.5s),
    // and under the full parallel `turbo run test` load it comfortably exceeds
    // Vitest's default 5s per-test budget. Mirror the explicit 120s timeout the
    // sibling bulk-sync property test uses so this test is deterministic under
    // load rather than flaky. (No live Redis is required — Prisma and the event
    // emitter are faked — so the ioredis reconnect noise in the log is benign.)
  }, 120_000);
});

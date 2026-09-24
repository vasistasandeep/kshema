import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type {
  BulkSync,
  BulkSyncResponse,
  GhostSignal,
  Heartbeat,
} from "@kshema/types";
import {
  createInMemoryQueueStore,
  ghostSignalKey,
  heartbeatKey,
  OfflineTelemetryQueue,
  type BulkSyncTransport,
} from "./offline-queue.js";

const DEVICE = "device-1";

function heartbeat(capturedAt: string, stepDelta = 10): Heartbeat {
  return { deviceId: DEVICE, screenUnlocks: [], stepDelta, capturedAt };
}

function ghost(detectedAt: string): GhostSignal {
  return { signalType: "HOME_WIFI_REASSOCIATION", detectedAt };
}

/**
 * Recording transport: toggleable connectivity + a captured payload log, plus a
 * server-reported sync time echoed back in the response.
 */
function makeTransport(options?: {
  online?: boolean;
  syncAt?: string;
}): BulkSyncTransport & { readonly calls: BulkSync[] } {
  const calls: BulkSync[] = [];
  return {
    calls,
    async isOnline() {
      return options?.online ?? true;
    },
    async flush(payload) {
      calls.push(payload);
      const response: BulkSyncResponse = {
        accepted: payload.heartbeats?.length ?? 0,
        duplicates: 0,
        clockSkewFlagged: 0,
        lastTelemetrySyncAt: options?.syncAt ?? "2025-01-01T06:00:00.000Z",
        results: [],
      };
      return response;
    },
  };
}

describe("OfflineTelemetryQueue buffering (R24.1)", () => {
  it("buffers heartbeats and ghost signals while offline and does not flush", async () => {
    const transport = makeTransport({ online: false });
    const queue = new OfflineTelemetryQueue(
      DEVICE,
      createInMemoryQueueStore(),
      transport,
    );

    await queue.enqueueHeartbeat(heartbeat("2025-01-01T05:30:00.000Z"));
    await queue.enqueueGhostSignal(ghost("2025-01-01T05:31:00.000Z"));

    expect(await queue.pendingCount()).toBe(2);
    const result = await queue.flush();
    expect(result.status).toBe("offline");
    expect(transport.calls).toHaveLength(0);
    // Items remain buffered for the next reconnect.
    expect(await queue.pendingCount()).toBe(2);
  });

  it("ignores an exact (deviceId, capturedAt) duplicate heartbeat", async () => {
    const queue = new OfflineTelemetryQueue(
      DEVICE,
      createInMemoryQueueStore(),
      makeTransport(),
    );
    await queue.enqueueHeartbeat(heartbeat("2025-01-01T05:30:00.000Z", 10));
    await queue.enqueueHeartbeat(heartbeat("2025-01-01T05:30:00.000Z", 99));
    expect(await queue.pendingCount()).toBe(1);
  });
});

describe("OfflineTelemetryQueue flush on reconnect (R24.2)", () => {
  it("flushes buffered items and clears them on success", async () => {
    const transport = makeTransport({
      online: true,
      syncAt: "2025-01-01T06:05:00.000Z",
    });
    const queue = new OfflineTelemetryQueue(
      DEVICE,
      createInMemoryQueueStore(),
      transport,
    );
    await queue.enqueueHeartbeat(heartbeat("2025-01-01T05:30:00.000Z"));
    await queue.enqueueGhostSignal(ghost("2025-01-01T05:31:00.000Z"));

    const result = await queue.flush();
    expect(result.status).toBe("flushed");
    if (result.status === "flushed") {
      expect(result.heartbeatsSent).toBe(1);
      expect(result.ghostSignalsSent).toBe(1);
    }
    expect(transport.calls).toHaveLength(1);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("advances lastSyncAt so the next payload carries it", async () => {
    const transport = makeTransport({ syncAt: "2025-01-01T06:05:00.000Z" });
    const queue = new OfflineTelemetryQueue(
      DEVICE,
      createInMemoryQueueStore(),
      transport,
    );
    await queue.enqueueHeartbeat(heartbeat("2025-01-01T05:30:00.000Z"));
    await queue.flush();

    await queue.enqueueHeartbeat(heartbeat("2025-01-01T05:45:00.000Z"));
    const payload = await queue.buildPayload();
    expect(payload.lastSyncAt).toBe("2025-01-01T06:05:00.000Z");
  });

  it("reports empty when nothing is buffered", async () => {
    const queue = new OfflineTelemetryQueue(
      DEVICE,
      createInMemoryQueueStore(),
      makeTransport(),
    );
    expect((await queue.flush()).status).toBe("empty");
  });
});

describe("Offline_Telemetry_Queue enqueue idempotency (property)", () => {
  // Feature: kshema-safety-platform, Property 11 (client-side complement:
  // re-enqueueing the same heartbeats never produces a duplicate in the buffer,
  // mirroring the API's (deviceId, capturedAt) idempotency key).
  it("re-enqueuing any multiset of heartbeats buffers exactly the distinct keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.integer({ min: 0, max: 20 }).map(
            (m) =>
              `2025-01-01T05:${String(m).padStart(2, "0")}:00.000Z`,
          ),
          { minLength: 0, maxLength: 40 },
        ),
        async (timestamps) => {
          const queue = new OfflineTelemetryQueue(
            DEVICE,
            createInMemoryQueueStore(),
            makeTransport({ online: false }),
          );
          for (const ts of timestamps) {
            await queue.enqueueHeartbeat(heartbeat(ts));
            // enqueue again immediately to exercise dedup
            await queue.enqueueHeartbeat(heartbeat(ts, 999));
          }
          const snap = await queue.snapshot();
          const distinct = new Set(
            timestamps.map((ts) => heartbeatKey(DEVICE, heartbeat(ts))),
          );
          expect(snap.heartbeats).toHaveLength(distinct.size);
          const bufferedKeys = new Set(
            snap.heartbeats.map((h) => heartbeatKey(DEVICE, h)),
          );
          expect(bufferedKeys).toEqual(distinct);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("key helpers", () => {
  it("distinguishes heartbeats by capturedAt and ghost signals by type/source/time", () => {
    expect(heartbeatKey(DEVICE, heartbeat("a"))).not.toBe(
      heartbeatKey(DEVICE, heartbeat("b")),
    );
    expect(ghostSignalKey(ghost("a"))).not.toBe(ghostSignalKey(ghost("b")));
  });
});

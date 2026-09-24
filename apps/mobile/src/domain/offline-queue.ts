/**
 * Offline_Telemetry_Queue buffering + bulk-sync flush (R24.1, R24.2).
 *
 * The background agent produces `Heartbeat`s and `GhostSignal`s continuously.
 * While the device has no connectivity they are buffered on-device here; when
 * connectivity returns the buffer is flushed to the Kshema_API as a single
 * `bulk-sync` request (mapping to `POST /api/v1/telemetry/bulk-sync`, whose
 * DTOs live in `@kshema/types`).
 *
 * This module is pure, framework-agnostic queue logic — no React Native, no
 * storage, no network. The persistent-store and network transport are injected
 * behind {@link QueueStore} and {@link BulkSyncTransport} so the buffering and
 * flush semantics are unit-testable under Node. The Expo bindings (AsyncStorage
 * / SQLite persistence + fetch transport) implement those interfaces.
 *
 * Buffering guarantees:
 *   - Heartbeats are de-duplicated on `(deviceId, capturedAt)` at enqueue time,
 *     matching the API's idempotency key (R24.2, Property 11) so a re-enqueue
 *     after a partial flush never double-counts.
 *   - Ghost signals are de-duplicated on `(signalType, source, detectedAt)`.
 *   - A flush is all-or-nothing from the queue's perspective: on transport
 *     success the flushed items are dropped; on failure they remain buffered
 *     for the next reconnect (R24.1 -> R24.2).
 */
import type {
  BulkSync,
  BulkSyncResponse,
  GhostSignal,
  Heartbeat,
} from "@kshema/types";

/** Idempotency key for a buffered heartbeat: `deviceId|capturedAt`. */
export function heartbeatKey(deviceId: string, h: Heartbeat): string {
  return `${deviceId}\u0000${h.capturedAt}`;
}

/** De-dup key for a buffered ghost signal: `signalType|source|detectedAt`. */
export function ghostSignalKey(g: GhostSignal): string {
  return `${g.signalType}\u0000${g.source ?? ""}\u0000${g.detectedAt}`;
}

/** Snapshot of everything currently buffered for a device. */
export interface BufferedTelemetry {
  readonly deviceId: string;
  readonly heartbeats: readonly Heartbeat[];
  readonly ghostSignals: readonly GhostSignal[];
  /** ISO timestamp of the last successful flush, if any (feeds `lastSyncAt`). */
  readonly lastSyncAt?: string;
}

/**
 * Persistent buffer for offline telemetry. Implementations must survive process
 * restarts (the agent may be killed and relaunched while offline). The in-memory
 * implementation below is used by tests and the domain layer.
 */
export interface QueueStore {
  load(deviceId: string): Promise<BufferedTelemetry>;
  save(state: BufferedTelemetry): Promise<void>;
}

/** Network transport that performs the actual bulk-sync API call. */
export interface BulkSyncTransport {
  /** Whether the device currently has connectivity. */
  isOnline(): Promise<boolean>;
  /** POST the payload to the API; resolves with the server response. */
  flush(payload: BulkSync): Promise<BulkSyncResponse>;
}

/** In-memory {@link QueueStore} for tests / the domain layer. */
export function createInMemoryQueueStore(
  seed?: BufferedTelemetry,
): QueueStore {
  const byDevice = new Map<string, BufferedTelemetry>();
  if (seed) byDevice.set(seed.deviceId, seed);
  return {
    async load(deviceId) {
      return (
        byDevice.get(deviceId) ?? {
          deviceId,
          heartbeats: [],
          ghostSignals: [],
        }
      );
    },
    async save(state) {
      byDevice.set(state.deviceId, state);
    },
  };
}

/** Result of a flush attempt. */
export type FlushResult =
  | { readonly status: "offline" }
  | { readonly status: "empty" }
  | {
      readonly status: "flushed";
      readonly response: BulkSyncResponse;
      readonly heartbeatsSent: number;
      readonly ghostSignalsSent: number;
    };

/**
 * The Offline_Telemetry_Queue for a single device. Wraps a {@link QueueStore}
 * with idempotent enqueue and a reconnect-driven flush.
 */
export class OfflineTelemetryQueue {
  constructor(
    private readonly deviceId: string,
    private readonly store: QueueStore,
    private readonly transport: BulkSyncTransport,
  ) {}

  /** Current buffered snapshot. */
  async snapshot(): Promise<BufferedTelemetry> {
    return this.store.load(this.deviceId);
  }

  /** Buffer a heartbeat, ignoring an exact `(deviceId, capturedAt)` duplicate. */
  async enqueueHeartbeat(heartbeat: Heartbeat): Promise<void> {
    const state = await this.store.load(this.deviceId);
    const key = heartbeatKey(this.deviceId, heartbeat);
    if (state.heartbeats.some((h) => heartbeatKey(this.deviceId, h) === key)) {
      return;
    }
    await this.store.save({
      ...state,
      deviceId: this.deviceId,
      heartbeats: [...state.heartbeats, heartbeat],
    });
  }

  /** Buffer a ghost signal, ignoring an exact duplicate. */
  async enqueueGhostSignal(signal: GhostSignal): Promise<void> {
    const state = await this.store.load(this.deviceId);
    const key = ghostSignalKey(signal);
    if (state.ghostSignals.some((g) => ghostSignalKey(g) === key)) {
      return;
    }
    await this.store.save({
      ...state,
      deviceId: this.deviceId,
      ghostSignals: [...state.ghostSignals, signal],
    });
  }

  /** How many items are currently buffered. */
  async pendingCount(): Promise<number> {
    const state = await this.store.load(this.deviceId);
    return state.heartbeats.length + state.ghostSignals.length;
  }

  /** Build the `bulk-sync` request body from the current buffer. */
  async buildPayload(): Promise<BulkSync> {
    const state = await this.store.load(this.deviceId);
    const payload: BulkSync = {
      deviceId: this.deviceId,
      heartbeats: [...state.heartbeats],
      ghostSignals: [...state.ghostSignals],
    };
    if (state.lastSyncAt !== undefined) {
      return { ...payload, lastSyncAt: state.lastSyncAt };
    }
    return payload;
  }

  /**
   * Flush the buffer to the API when online (R24.2). No-op when offline (items
   * stay buffered, R24.1) or when nothing is buffered. On success the flushed
   * items are dropped and `lastSyncAt` advances to the server-reported sync
   * time so the next payload carries an accurate `lastSyncAt` (R24.3 input).
   */
  async flush(): Promise<FlushResult> {
    const state = await this.store.load(this.deviceId);
    if (state.heartbeats.length === 0 && state.ghostSignals.length === 0) {
      return { status: "empty" };
    }
    if (!(await this.transport.isOnline())) {
      return { status: "offline" };
    }

    const payload = await this.buildPayload();
    const response = await this.transport.flush(payload);

    // Success: drop exactly what we sent. Any items enqueued during the flush
    // (a fresh load) are preserved.
    const sentHeartbeatKeys = new Set(
      payload.heartbeats.map((h) => heartbeatKey(this.deviceId, h)),
    );
    const sentGhostKeys = new Set(payload.ghostSignals.map(ghostSignalKey));
    const after = await this.store.load(this.deviceId);
    await this.store.save({
      deviceId: this.deviceId,
      heartbeats: after.heartbeats.filter(
        (h) => !sentHeartbeatKeys.has(heartbeatKey(this.deviceId, h)),
      ),
      ghostSignals: after.ghostSignals.filter(
        (g) => !sentGhostKeys.has(ghostSignalKey(g)),
      ),
      lastSyncAt: response.lastTelemetrySyncAt,
    });

    return {
      status: "flushed",
      response,
      heartbeatsSent: payload.heartbeats.length,
      ghostSignalsSent: payload.ghostSignals.length,
    };
  }
}

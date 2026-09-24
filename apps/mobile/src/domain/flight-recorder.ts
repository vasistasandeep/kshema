/**
 * Zero-Knowledge Ephemeral Flight Recorder — on-device capture + envelope
 * (R8.1, R8.2, R8.3, R8.4; task 22.3).
 *
 * The Flight Recorder captures a low-fidelity {@link ContextSnapshot} every
 * 3 minutes into a bounded rolling ring buffer, then serializes, compresses,
 * and encrypts that buffer into an Encrypted_Black_Box every 15 minutes for
 * upload to the server-blind blackbox-sync route. The server can never read the
 * payload (R8.6, R19.3) — it is fanned-out-wrapped to authorized Observer
 * public keys only, using `@kshema/encryption` (the same envelope the Observer
 * app / Web_Crypto_Vault later decrypts, R8.9).
 *
 * Everything here is framework-agnostic:
 *   - {@link FlightRecorderBuffer} is a pure ring buffer (R8.2, R8.3),
 *   - {@link encryptBuffer} composes `@kshema/encryption`'s `encryptBlackBox`
 *     over a snapshot list (R8.4, R8.5),
 *   - {@link FlightRecorder} orchestrates capture + periodic seal behind
 *     injectable seams ({@link SnapshotSource}, {@link BlackBoxUploader}), so
 *     the timing/coarse-location/battery reads and the network upload live in
 *     the Expo platform binding, while the buffer/cadence logic is unit-tested
 *     under Node.
 *
 * The private key is never involved on the capture side: encryption only ever
 * needs Observer *public* keys (R8.5), so this module holds no decrypt path.
 */
import { encryptBlackBox } from "@kshema/encryption";
import type {
  EncryptedBlackBoxRecord,
  ObserverPublicKey,
} from "@kshema/encryption";

/** Capture interval: one snapshot every 3 minutes (R8.1). */
export const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;

/** Seal (encrypt + upload) interval: every 15 minutes (R8.4). */
export const SEAL_INTERVAL_MS = 15 * 60 * 1000;

/** Hard cap on the rolling buffer: at most 20 snapshots (R8.2). */
export const MAX_SNAPSHOTS = 20;

/**
 * Maximum history window represented by a full buffer: at most 60 minutes
 * (R8.2). With a 3-minute cadence, 20 snapshots span exactly 60 minutes, so the
 * count cap and the time cap agree; the time cap is enforced independently in
 * case cadence drifts (missed ticks under Doze/background throttling).
 */
export const MAX_WINDOW_MS = 60 * 60 * 1000;

/**
 * A single low-fidelity context snapshot (R8.1). Deliberately coarse: coarse
 * location (never a continuous fine GPS trace, R19.1), the current Wi-Fi
 * association, and battery state. Field values are captured by the platform
 * {@link SnapshotSource}; this type is what gets serialized into the black box.
 */
export interface ContextSnapshot {
  /** Capture time (epoch-millis). */
  readonly capturedAt: number;
  /** Coarse location, if permitted. Rounded/low-precision, never a fine trace. */
  readonly coarseLocation?: {
    readonly lat: number;
    readonly lon: number;
    /** Reported horizontal accuracy in metres, if known. */
    readonly accuracyM?: number;
  };
  /** SSID / BSSID label of the current Wi-Fi association, if any. */
  readonly wifiAssociation?: string;
  /** Battery level as a percentage in [0, 100]. */
  readonly batteryLevel?: number;
  /** Charger state at capture time. */
  readonly chargerState?: "PLUGGED" | "UNPLUGGED";
}

/**
 * Bounded rolling ring buffer of context snapshots (R8.2, R8.3).
 *
 * Enforces both caps on every push:
 *   - **count**: never more than {@link MAX_SNAPSHOTS} (20) — the oldest is
 *     discarded as each new snapshot is added (R8.3);
 *   - **window**: never spanning more than {@link MAX_WINDOW_MS} (60m) — any
 *     snapshot older than `newest - 60m` is evicted, so a burst of catch-up
 *     captures after a background gap cannot smuggle in stale context.
 *
 * The buffer is a plain in-memory structure; nothing is persisted to disk
 * (persistence would violate the "ephemeral" guarantee). A snapshot list read
 * back via {@link snapshots} is a defensive copy in capture order (oldest
 * first).
 */
export class FlightRecorderBuffer {
  private readonly items: ContextSnapshot[] = [];

  constructor(
    private readonly maxSnapshots: number = MAX_SNAPSHOTS,
    private readonly maxWindowMs: number = MAX_WINDOW_MS,
  ) {
    if (maxSnapshots < 1) {
      throw new RangeError("FlightRecorderBuffer requires maxSnapshots >= 1");
    }
  }

  /**
   * Append a snapshot, then enforce the window and count caps (R8.2, R8.3).
   * Returns the snapshots evicted by this push (oldest-first), if any — useful
   * for tests and diagnostics.
   */
  push(snapshot: ContextSnapshot): ContextSnapshot[] {
    this.items.push(snapshot);
    const evicted: ContextSnapshot[] = [];

    // Window cap first: drop anything older than (newest - maxWindowMs).
    const newest = this.items[this.items.length - 1]!.capturedAt;
    const cutoff = newest - this.maxWindowMs;
    while (this.items.length > 0 && this.items[0]!.capturedAt < cutoff) {
      evicted.push(this.items.shift()!);
    }

    // Count cap: discard the oldest until at most maxSnapshots remain (R8.3).
    while (this.items.length > this.maxSnapshots) {
      evicted.push(this.items.shift()!);
    }

    return evicted;
  }

  /** Current number of buffered snapshots (0..maxSnapshots). */
  get size(): number {
    return this.items.length;
  }

  /** Defensive copy of the buffered snapshots, oldest-first. */
  snapshots(): ContextSnapshot[] {
    return this.items.slice();
  }

  /** Time span currently covered by the buffer in ms (0 when <2 snapshots). */
  windowMs(): number {
    if (this.items.length < 2) return 0;
    return (
      this.items[this.items.length - 1]!.capturedAt - this.items[0]!.capturedAt
    );
  }

  /** Clear the buffer (used after a seal is not required — buffer is rolling). */
  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Serialize + compress + encrypt a snapshot list into an Encrypted_Black_Box
 * (R8.4, R8.5). Thin wrapper over `@kshema/encryption`'s `encryptBlackBox`,
 * kept here so the mobile layer has a single, named seal step and so the
 * payload shape (`{ v, snapshots }`) is explicit and versioned for the Observer
 * decrypt side.
 *
 * The symmetric key is fanned out once per authorized Observer public key; no
 * private-key material is touched. Requires at least one Observer key (an empty
 * fan-out would produce an undecryptable box) — {@link encryptBlackBox} throws
 * on an empty list.
 */
export function encryptBuffer(
  snapshots: readonly ContextSnapshot[],
  observerPublicKeys: readonly ObserverPublicKey[],
): EncryptedBlackBoxRecord {
  return encryptBlackBox(
    { v: 1 as const, snapshots: snapshots.slice() },
    observerPublicKeys,
  );
}

/**
 * Platform seam that reads a fresh {@link ContextSnapshot} from the device
 * (coarse location + Wi-Fi association + battery). Implemented in the Expo
 * binding; a spy/generator in tests. Kept async because location/Wi-Fi reads
 * are async on device.
 */
export interface SnapshotSource {
  capture(now: number): Promise<ContextSnapshot> | ContextSnapshot;
}

/**
 * Platform seam that uploads a sealed Encrypted_Black_Box to the server-blind
 * `POST /telemetry/blackbox-sync` route (R8.6). Implemented in the Expo binding
 * over the API client; a spy in tests. The uploader never receives or returns
 * plaintext or key material beyond the already-wrapped record.
 */
export interface BlackBoxUploader {
  upload(record: EncryptedBlackBoxRecord): Promise<void>;
}

/** Seams + config the {@link FlightRecorder} orchestrator depends on. */
export interface FlightRecorderDeps {
  readonly source: SnapshotSource;
  readonly uploader: BlackBoxUploader;
  /**
   * Supplies the current set of black-box-authorized Observer public keys for
   * the Anchor's Circle. Read at seal time so a re-invited/rotated Observer key
   * is picked up on the next seal without restarting the recorder.
   */
  readonly observerKeys: () =>
    | Promise<readonly ObserverPublicKey[]>
    | readonly ObserverPublicKey[];
  /** Capture cadence override (defaults to {@link SNAPSHOT_INTERVAL_MS}). */
  readonly snapshotIntervalMs?: number;
  /** Seal cadence override (defaults to {@link SEAL_INTERVAL_MS}). */
  readonly sealIntervalMs?: number;
  /** Buffer bounds override (defaults to the R8.2 caps). */
  readonly maxSnapshots?: number;
  readonly maxWindowMs?: number;
}

/** Outcome of a single {@link FlightRecorder.seal} attempt. */
export type SealOutcome =
  | { sealed: false; reason: "empty-buffer" | "no-observers" }
  | { sealed: true; snapshotCount: number; record: EncryptedBlackBoxRecord };

/**
 * Orchestrates Flight Recorder capture and periodic sealing (R8.1–R8.4) behind
 * injectable seams. This class holds NO timers itself — the platform binding
 * drives it via {@link tick} on the schedule it manages (Android foreground
 * service / iOS background task), so the cadence logic stays testable under
 * Node with a virtual clock.
 *
 *   - {@link tick}(now) captures a snapshot when a capture interval has elapsed
 *     and seals+uploads when a seal interval has elapsed.
 *   - {@link capture}/{@link seal} expose the two steps directly for the binding
 *     and for tests.
 *
 * The rolling buffer is *not* cleared on seal: the black box is a rolling
 * 60-minute window, so each seal re-encrypts the current buffer (R8.2). Sealing
 * with no authorized Observer key is a safe no-op (nothing decryptable could be
 * produced) rather than an error.
 */
export class FlightRecorder {
  private readonly buffer: FlightRecorderBuffer;
  private readonly snapshotIntervalMs: number;
  private readonly sealIntervalMs: number;
  private lastCaptureAt: number | null = null;
  private lastSealAt: number | null = null;

  constructor(private readonly deps: FlightRecorderDeps) {
    this.buffer = new FlightRecorderBuffer(
      deps.maxSnapshots ?? MAX_SNAPSHOTS,
      deps.maxWindowMs ?? MAX_WINDOW_MS,
    );
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.sealIntervalMs = deps.sealIntervalMs ?? SEAL_INTERVAL_MS;
  }

  /** Current buffered snapshot count (for diagnostics/tests). */
  get bufferSize(): number {
    return this.buffer.size;
  }

  /** Read-only view of the buffered snapshots (oldest-first). */
  snapshots(): ContextSnapshot[] {
    return this.buffer.snapshots();
  }

  /**
   * Capture one snapshot from the {@link SnapshotSource} into the ring buffer
   * (R8.1). Returns the captured snapshot. Records the capture time for cadence
   * bookkeeping.
   */
  async capture(now: number): Promise<ContextSnapshot> {
    const snapshot = await this.deps.source.capture(now);
    this.buffer.push(snapshot);
    this.lastCaptureAt = now;
    return snapshot;
  }

  /**
   * Seal the current buffer into an Encrypted_Black_Box and upload it (R8.4).
   * No-op when the buffer is empty or no authorized Observer key exists — both
   * cases return `{ sealed: false }` without touching the uploader. Records the
   * seal time for cadence bookkeeping only when a seal actually occurred.
   */
  async seal(now: number): Promise<SealOutcome> {
    const snapshots = this.buffer.snapshots();
    if (snapshots.length === 0) {
      return { sealed: false, reason: "empty-buffer" };
    }
    const observerKeys = await this.deps.observerKeys();
    if (observerKeys.length === 0) {
      return { sealed: false, reason: "no-observers" };
    }
    const record = encryptBuffer(snapshots, observerKeys);
    await this.deps.uploader.upload(record);
    this.lastSealAt = now;
    return { sealed: true, snapshotCount: snapshots.length, record };
  }

  /**
   * Advance the recorder to wall-clock `now`. Captures a snapshot if at least
   * one snapshot interval has elapsed since the last capture (or on first tick),
   * then seals if at least one seal interval has elapsed since the last seal (or
   * on first tick, once there is something to seal). Returns what happened so
   * the binding/tests can assert cadence.
   */
  async tick(now: number): Promise<{
    captured: ContextSnapshot | null;
    seal: SealOutcome | null;
  }> {
    let captured: ContextSnapshot | null = null;
    if (
      this.lastCaptureAt === null ||
      now - this.lastCaptureAt >= this.snapshotIntervalMs
    ) {
      captured = await this.capture(now);
    }

    let seal: SealOutcome | null = null;
    if (
      this.lastSealAt === null ||
      now - this.lastSealAt >= this.sealIntervalMs
    ) {
      seal = await this.seal(now);
      // A no-op seal (empty buffer / no observers) must NOT reset the seal
      // clock, so we retry on the next tick. `seal()` only sets lastSealAt on a
      // real seal, so nothing to undo here.
    }

    return { captured, seal };
  }
}

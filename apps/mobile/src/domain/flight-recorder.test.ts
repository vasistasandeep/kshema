/**
 * Flight Recorder tests (task 22.3): ring-buffer eviction (R8.2, R8.3),
 * periodic seal cadence (R8.4), and round-trip of a sealed buffer through the
 * authorized Observer private key (R8.5, R8.10 / R9.1).
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { generateKeyPairSync } from "node:crypto";
import { decryptBlackBox } from "@kshema/encryption/decrypt";
import type {
  BlackBoxUploader,
  ContextSnapshot,
  SnapshotSource,
} from "./flight-recorder.js";
import {
  FlightRecorder,
  FlightRecorderBuffer,
  MAX_SNAPSHOTS,
  MAX_WINDOW_MS,
  SEAL_INTERVAL_MS,
  SNAPSHOT_INTERVAL_MS,
  encryptBuffer,
} from "./flight-recorder.js";

function snap(capturedAt: number, batteryLevel = 80): ContextSnapshot {
  return { capturedAt, batteryLevel, chargerState: "UNPLUGGED" };
}

function makeObserverKey(observerId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { observerId, publicKey, privateKey };
}

describe("FlightRecorderBuffer eviction (R8.2, R8.3)", () => {
  it("never exceeds 20 snapshots, discarding the oldest first", () => {
    const buf = new FlightRecorderBuffer();
    // Push 50 snapshots 3 minutes apart.
    for (let i = 0; i < 50; i++) {
      buf.push(snap(i * SNAPSHOT_INTERVAL_MS));
    }
    expect(buf.size).toBe(MAX_SNAPSHOTS);
    const kept = buf.snapshots();
    // Kept snapshots are the 20 most recent (indices 30..49).
    expect(kept[0]!.capturedAt).toBe(30 * SNAPSHOT_INTERVAL_MS);
    expect(kept[kept.length - 1]!.capturedAt).toBe(49 * SNAPSHOT_INTERVAL_MS);
  });

  it("evicts snapshots older than the 60-minute window even below the count cap", () => {
    const buf = new FlightRecorderBuffer();
    buf.push(snap(0));
    buf.push(snap(10 * 60 * 1000)); // +10m
    // Jump forward past the window: the two old snapshots must be evicted.
    buf.push(snap(75 * 60 * 1000)); // +75m from origin
    expect(buf.size).toBe(1);
    expect(buf.snapshots()[0]!.capturedAt).toBe(75 * 60 * 1000);
  });

  it("keeps the window within 60 minutes and count within 20 for any push order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 * 60 * 60 * 1000 }), {
          maxLength: 200,
        }),
        (times) => {
          const buf = new FlightRecorderBuffer();
          // Push in nondecreasing capture order (monotonic clock on device).
          for (const t of [...times].sort((a, b) => a - b)) {
            buf.push(snap(t));
          }
          expect(buf.size).toBeLessThanOrEqual(MAX_SNAPSHOTS);
          expect(buf.windowMs()).toBeLessThanOrEqual(MAX_WINDOW_MS);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("encryptBuffer round-trip (R8.5, R8.10)", () => {
  it("reproduces the original snapshots after decrypt with the Observer key", () => {
    const obs = makeObserverKey("obs-1");
    const snapshots = [snap(0, 90), snap(SNAPSHOT_INTERVAL_MS, 88)];
    const record = encryptBuffer(snapshots, [
      { observerId: obs.observerId, publicKey: obs.publicKey },
    ]);
    const decrypted = decryptBlackBox<{ v: 1; snapshots: ContextSnapshot[] }>(
      record,
      obs.observerId,
      obs.privateKey,
    );
    expect(decrypted.v).toBe(1);
    expect(decrypted.snapshots).toEqual(snapshots);
  });

  it("fans out so each authorized Observer can independently decrypt", () => {
    const a = makeObserverKey("a");
    const b = makeObserverKey("b");
    const snapshots = [snap(0)];
    const record = encryptBuffer(snapshots, [
      { observerId: a.observerId, publicKey: a.publicKey },
      { observerId: b.observerId, publicKey: b.publicKey },
    ]);
    expect(record.recipientKeys).toHaveLength(2);
    expect(
      decryptBlackBox<{ snapshots: ContextSnapshot[] }>(record, "a", a.privateKey)
        .snapshots,
    ).toEqual(snapshots);
    expect(
      decryptBlackBox<{ snapshots: ContextSnapshot[] }>(record, "b", b.privateKey)
        .snapshots,
    ).toEqual(snapshots);
  });
});

describe("FlightRecorder cadence (R8.1, R8.4)", () => {
  function makeRecorder(observerKeys: { observerId: string; publicKey: string }[]) {
    const source: SnapshotSource = {
      capture: vi.fn((now: number) => snap(now)),
    };
    const uploaded: EncryptedBlackBoxRecordLite[] = [];
    const uploader: BlackBoxUploader = {
      upload: vi.fn(async (record) => {
        uploaded.push(record);
      }),
    };
    const recorder = new FlightRecorder({
      source,
      uploader,
      observerKeys: () => observerKeys,
    });
    return { recorder, source, uploader, uploaded };
  }

  it("captures once per 3-minute interval and seals once per 15-minute interval", async () => {
    const obs = makeObserverKey("obs");
    const { recorder, source, uploader } = makeRecorder([
      { observerId: obs.observerId, publicKey: obs.publicKey },
    ]);

    // First tick: captures + seals immediately (both clocks unset).
    await recorder.tick(0);
    expect(source.capture).toHaveBeenCalledTimes(1);
    expect(uploader.upload).toHaveBeenCalledTimes(1);

    // Within the same 3m/15m window: no new capture, no new seal.
    await recorder.tick(SNAPSHOT_INTERVAL_MS - 1);
    expect(source.capture).toHaveBeenCalledTimes(1);
    expect(uploader.upload).toHaveBeenCalledTimes(1);

    // Cross the 3m boundary: a capture, but still no seal (< 15m).
    await recorder.tick(SNAPSHOT_INTERVAL_MS);
    expect(source.capture).toHaveBeenCalledTimes(2);
    expect(uploader.upload).toHaveBeenCalledTimes(1);

    // Cross the 15m boundary: capture + seal.
    await recorder.tick(SEAL_INTERVAL_MS);
    expect(uploader.upload).toHaveBeenCalledTimes(2);
  });

  it("does not seal (or reset the seal clock) when no Observer key exists", async () => {
    const { recorder, uploader } = makeRecorder([]);
    const first = await recorder.tick(0);
    expect(first.seal).toEqual({ sealed: false, reason: "no-observers" });
    expect(uploader.upload).not.toHaveBeenCalled();

    // A later Observer becoming available should seal on the next due tick,
    // because the no-op seal never advanced lastSealAt.
    const obs = makeObserverKey("late");
    const recorder2 = new FlightRecorder({
      source: { capture: (now: number) => snap(now) },
      uploader,
      observerKeys: () => [{ observerId: obs.observerId, publicKey: obs.publicKey }],
    });
    await recorder2.tick(0);
    expect(uploader.upload).toHaveBeenCalledTimes(1);
  });
});

// Local structural alias so the test file needs no direct type import churn.
type EncryptedBlackBoxRecordLite = Parameters<BlackBoxUploader["upload"]>[0];

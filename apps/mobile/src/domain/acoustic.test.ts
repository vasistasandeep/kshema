/**
 * Acoustic distress gate tests (task 22.3): sustained-run folding, the on-device
 * pre-filter mirroring the worker gate (R10.3, R10.4), and the in-memory-only
 * contract (R10.2, R19.4 — no audio ever leaves this layer).
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  ACOUSTIC_CONFIDENCE_THRESHOLD,
  ACOUSTIC_MOTIONLESS_THRESHOLD_SEC,
  ACOUSTIC_SUSTAINED_THRESHOLD_SEC,
  AcousticDistressGate,
  meetsAcousticThreshold,
  processAcousticFrame,
  type AcousticSignal,
  type AcousticSignalSink,
} from "./acoustic.js";

describe("meetsAcousticThreshold (R10.3, R10.4)", () => {
  it("accepts iff confidence>0.82 AND sustained>1.5s AND motionless>=30s", () => {
    fc.assert(
      fc.property(
        fc.record({
          confidence: fc.double({ min: 0, max: 1, noNaN: true }),
          sustainedSec: fc.double({ min: 0, max: 10, noNaN: true }),
          motionlessSec: fc.double({ min: 0, max: 120, noNaN: true }),
        }),
        ({ confidence, sustainedSec, motionlessSec }) => {
          const signal: AcousticSignal = {
            category: "HEAVY_IMPACT",
            confidence,
            sustainedSec,
            motionlessSec,
          };
          const expected =
            confidence > ACOUSTIC_CONFIDENCE_THRESHOLD &&
            sustainedSec > ACOUSTIC_SUSTAINED_THRESHOLD_SEC &&
            motionlessSec >= ACOUSTIC_MOTIONLESS_THRESHOLD_SEC;
          expect(meetsAcousticThreshold(signal)).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("excludes exactly-at-threshold confidence (0.82) and sustained (1.5s)", () => {
    expect(
      meetsAcousticThreshold({
        category: "GLASS_BREAKAGE",
        confidence: 0.82,
        sustainedSec: 2,
        motionlessSec: 40,
      }),
    ).toBe(false);
    expect(
      meetsAcousticThreshold({
        category: "GLASS_BREAKAGE",
        confidence: 0.9,
        sustainedSec: 1.5,
        motionlessSec: 40,
      }),
    ).toBe(false);
    // motionless is inclusive at 30s.
    expect(
      meetsAcousticThreshold({
        category: "GLASS_BREAKAGE",
        confidence: 0.9,
        sustainedSec: 2,
        motionlessSec: 30,
      }),
    ).toBe(true);
  });

  it("rejects non-finite inputs", () => {
    expect(
      meetsAcousticThreshold({
        category: "VOCAL_DISTRESS",
        confidence: Number.NaN,
        sustainedSec: 5,
        motionlessSec: 60,
      }),
    ).toBe(false);
  });
});

describe("AcousticDistressGate run folding", () => {
  it("accumulates sustained seconds and peak confidence over a run", () => {
    const gate = new AcousticDistressGate();
    const motion = { motionlessSec: 40 };
    gate.observe({ category: "HEAVY_IMPACT", confidence: 0.7 }, 0, motion);
    gate.observe({ category: "HEAVY_IMPACT", confidence: 0.95 }, 800, motion);
    const s = gate.observe({ category: "HEAVY_IMPACT", confidence: 0.88 }, 1600, motion);
    expect(s).not.toBeNull();
    expect(s!.sustainedSec).toBeCloseTo(1.6, 5);
    expect(s!.confidence).toBe(0.95); // peak
    expect(s!.category).toBe("HEAVY_IMPACT");
  });

  it("resets the run when the category changes", () => {
    const gate = new AcousticDistressGate();
    const motion = { motionlessSec: 40 };
    gate.observe({ category: "HEAVY_IMPACT", confidence: 0.9 }, 0, motion);
    const s = gate.observe({ category: "GLASS_BREAKAGE", confidence: 0.9 }, 500, motion);
    // New run started at 500 → sustained ~0.
    expect(s!.category).toBe("GLASS_BREAKAGE");
    expect(s!.sustainedSec).toBeCloseTo(0, 5);
  });

  it("breaks the run on a below-floor / null frame and returns null", () => {
    const gate = new AcousticDistressGate();
    const motion = { motionlessSec: 40 };
    gate.observe({ category: "VOCAL_DISTRESS", confidence: 0.9 }, 0, motion);
    expect(gate.observe(null, 500, motion)).toBeNull();
  });
});

describe("processAcousticFrame → sink (R10.2, R19.4)", () => {
  it("emits a distilled signal (no audio) once a sustained distress qualifies", async () => {
    const emitted: AcousticSignal[] = [];
    const sink: AcousticSignalSink = {
      emit: vi.fn(async (s) => {
        emitted.push(s);
      }),
    };
    const gate = new AcousticDistressGate();
    const motion = { motionlessSec: 45 };

    // Frames sustaining >1.5s at high confidence, device motionless >=30s.
    await processAcousticFrame(gate, sink, { category: "HEAVY_IMPACT", confidence: 0.9 }, 0, motion);
    await processAcousticFrame(gate, sink, { category: "HEAVY_IMPACT", confidence: 0.95 }, 900, motion);
    const emittedSignal = await processAcousticFrame(
      gate,
      sink,
      { category: "HEAVY_IMPACT", confidence: 0.93 },
      1800,
      motion,
    );

    expect(emittedSignal).not.toBeNull();
    expect(sink.emit).toHaveBeenCalledTimes(1);
    // The emitted payload carries only distilled scalars — never audio samples.
    expect(Object.keys(emitted[0]!).sort()).toEqual([
      "category",
      "confidence",
      "motionlessSec",
      "sustainedSec",
    ]);
  });

  it("never emits when motionless < 30s even with strong sustained audio", async () => {
    const sink: AcousticSignalSink = { emit: vi.fn(async () => {}) };
    const gate = new AcousticDistressGate();
    const motion = { motionlessSec: 5 };
    for (const t of [0, 900, 1800, 2700]) {
      await processAcousticFrame(gate, sink, { category: "GLASS_BREAKAGE", confidence: 0.99 }, t, motion);
    }
    expect(sink.emit).not.toHaveBeenCalled();
  });
});

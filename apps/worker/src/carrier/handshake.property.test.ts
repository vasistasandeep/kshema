// Feature: kshema-safety-platform, Property 21
/**
 * Property 21: AMD & DTMF acknowledgment gating.
 *
 * *For all* Stage-4 voice dispatch attempts characterized by
 * (dtmfDigit, dtmfDelaySec), the attempt SHALL be counted as acknowledged if
 * and only if the received DTMF digit is `1` AND `dtmfDelaySec <= 15`. Any
 * other digit, no digit at all, or a confirming digit that arrives after the
 * 15s gather window SHALL mark the attempt UNACKNOWLEDGED (design "Property 21",
 * R31.1 AMD, R31.2 DTMF `1`/15s handshake, R31.3 retry/failover on
 * unacknowledged).
 *
 * The single acknowledgment rule lives in {@link isHandshakeAcknowledged} and
 * is exercised end-to-end through the real {@link MockCarrierAdapter} code path:
 * a scripted {@link ScriptedVoiceOutcome} is fed to `placeVoiceWithHandshake`,
 * which derives `acknowledged` via that shared rule. The property asserts the
 * carrier's boolean matches the IFF specification for every generated input,
 * and that "wrong digit / no digit / late digit" is never acknowledged.
 *
 * Validates: Requirements 31.1, 31.2, 31.3
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { MockCarrierAdapter } from "./mock-carrier-adapter.js";
import {
  HANDSHAKE_CONFIRM_DIGIT,
  HANDSHAKE_GATHER_TIMEOUT_SEC,
  isHandshakeAcknowledged,
  type VoiceHandshakeCall,
} from "./types.js";

/** Silent logger so the property run doesn't spew mock-carrier logs. */
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** The standard Stage-4 handshake call (AMD + gather '1' within 15s). */
const voiceCall: VoiceHandshakeCall = {
  to: "+919876543210",
  messageText: "This is a Kshema safety check. Press 1 to confirm.",
  amd: true,
  gatherDigit: HANDSHAKE_CONFIRM_DIGIT,
  gatherTimeoutSec: HANDSHAKE_GATHER_TIMEOUT_SEC,
};

/** The reference oracle: acknowledged IFF digit is '1' AND delay <= 15s. */
function shouldAcknowledge(dtmfDigit: string | undefined, dtmfDelaySec: number): boolean {
  return dtmfDigit === HANDSHAKE_CONFIRM_DIGIT && dtmfDelaySec <= HANDSHAKE_GATHER_TIMEOUT_SEC;
}

/**
 * Arbitrary DTMF digits: the confirm digit '1', other keypad digits, a
 * multi-char string, plus `undefined` (no tone / timeout). Deliberately
 * over-samples '1' so both branches of the IFF get hit often.
 */
const dtmfDigitArb = fc.oneof(
  fc.constant<string | undefined>(HANDSHAKE_CONFIRM_DIGIT),
  fc.constantFrom<string>("0", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "11"),
  fc.constant<string | undefined>(undefined),
);

/**
 * Arbitrary arrival delays in seconds, straddling the 15s boundary (including
 * the exact 15s edge and just-past-16s) as well as far-past values.
 */
const dtmfDelaySecArb = fc.oneof(
  fc.integer({ min: 0, max: 30 }),
  fc.constantFrom(14, 15, 16), // pin the boundary
  fc.double({ min: 0, max: 30, noNaN: true }),
);

describe("Property 21: AMD & DTMF acknowledgment gating", () => {
  it("acknowledged IFF DTMF '1' arrives within 15s — via MockCarrierAdapter (real code path)", async () => {
    await fc.assert(
      fc.asyncProperty(dtmfDigitArb, dtmfDelaySecArb, async (dtmfDigit, dtmfDelaySec) => {
        const carrier = new MockCarrierAdapter({
          logger: silentLogger,
          voicePlan: {
            mode: "fixed",
            outcome: {
              // When no digit was pressed, omit delay too (models timeout/silence).
              ...(dtmfDigit === undefined ? {} : { dtmfDigit, dtmfDelaySec }),
              connectedAtMs: 1_000_000,
            },
          },
        });

        const result = await carrier.placeVoiceWithHandshake(voiceCall);

        const expected = shouldAcknowledge(dtmfDigit, dtmfDelaySec);
        expect(result.acknowledged).toBe(expected);

        // Wrong digit, no digit, or a late digit is NEVER acknowledged.
        if (dtmfDigit !== HANDSHAKE_CONFIRM_DIGIT || dtmfDelaySec > HANDSHAKE_GATHER_TIMEOUT_SEC) {
          expect(result.acknowledged).toBe(false);
        }

        // The raw digit is still surfaced for the audit trail even when late/wrong.
        if (dtmfDigit !== undefined) {
          expect(result.dtmfDigit).toBe(dtmfDigit);
        } else {
          expect(result.dtmfDigit).toBeUndefined();
        }
      }),
      { numRuns: 300 },
    );
  });

  it("isHandshakeAcknowledged matches the IFF oracle for arbitrary (digit, delay)", () => {
    fc.assert(
      fc.property(dtmfDigitArb, dtmfDelaySecArb, (dtmfDigit, dtmfDelaySec) => {
        const acknowledged = isHandshakeAcknowledged({
          dtmfDigit,
          dtmfDelaySec: dtmfDigit === undefined ? undefined : dtmfDelaySec,
          gatherTimeoutSec: HANDSHAKE_GATHER_TIMEOUT_SEC,
        });
        expect(acknowledged).toBe(shouldAcknowledge(dtmfDigit, dtmfDelaySec));
      }),
      { numRuns: 300 },
    );
  });

  it("no confirming tone (timeout/silence) is never acknowledged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 60 }), async (_delaySec) => {
        const carrier = new MockCarrierAdapter({
          logger: silentLogger,
          voicePlan: { mode: "fixed", outcome: { amdCode: "TIMEOUT" } },
        });
        const result = await carrier.placeVoiceWithHandshake(voiceCall);
        expect(result.acknowledged).toBe(false);
        expect(result.dtmfDigit).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

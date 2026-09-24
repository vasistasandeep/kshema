import { describe, expect, it, vi } from "vitest";

import { MockCarrierAdapter } from "./mock-carrier-adapter.js";
import {
  HANDSHAKE_CONFIRM_DIGIT,
  HANDSHAKE_GATHER_TIMEOUT_SEC,
  type VoiceHandshakeCall,
} from "./types.js";

/** Silent logger so tests don't spew mock-carrier logs. */
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const voiceCall: VoiceHandshakeCall = {
  to: "+919876543210",
  messageText: "This is a Kshema safety check. Press 1 to confirm.",
  amd: true,
  gatherDigit: HANDSHAKE_CONFIRM_DIGIT,
  gatherTimeoutSec: HANDSHAKE_GATHER_TIMEOUT_SEC,
};

describe("MockCarrierAdapter — messaging", () => {
  it("records and logs a WhatsApp send and reports acceptance", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const carrier = new MockCarrierAdapter({ logger });

    const result = await carrier.sendWhatsApp({
      to: "+919876543210",
      template: "safety_check",
      lang: "hi",
    });

    expect(result.accepted).toBe(true);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(carrier.sentMessages).toHaveLength(1);
    expect(carrier.sentMessages[0]).toEqual({
      kind: "whatsapp",
      msg: { to: "+919876543210", template: "safety_check", lang: "hi" },
    });
  });

  it("records and logs an SMS send", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const carrier = new MockCarrierAdapter({ logger });

    await carrier.sendSms({ to: "+919000000000", body: "Please check in." });

    expect(logger.info).toHaveBeenCalledOnce();
    expect(carrier.sentMessages).toHaveLength(1);
    expect(carrier.sentMessages[0]).toEqual({
      kind: "sms",
      msg: { to: "+919000000000", body: "Please check in." },
    });
  });

  it("reports rejection when deliverySucceeds is false", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      deliverySucceeds: false,
    });

    const result = await carrier.sendSms({ to: "+910000000000", body: "hi" });

    expect(result.accepted).toBe(false);
    expect(result.diagnostic).toBe("MOCK_REJECTED");
  });
});

describe("MockCarrierAdapter — voice handshake (R31)", () => {
  it("returns an acknowledged result when DTMF '1' arrives within 15s", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "fixed",
        outcome: {
          dtmfDigit: "1",
          dtmfDelaySec: 8,
          amdCode: "HUMAN",
          connectedAtMs: 1_000_000,
        },
      },
    });

    const result = await carrier.placeVoiceWithHandshake(voiceCall);

    expect(result.acknowledged).toBe(true);
    expect(result.amdCode).toBe("HUMAN");
    expect(result.dtmfDigit).toBe("1");
    expect(result.dtmfDelaySec).toBe(8);
    // dtmfAtMs = connectedAtMs + delaySec*1000
    expect(result.dtmfAtMs).toBe(1_000_000 + 8_000);
  });

  it("marks unacknowledged when DTMF arrives after the 15s window", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "fixed",
        outcome: { dtmfDigit: "1", dtmfDelaySec: 20, connectedAtMs: 0 },
      },
    });

    const result = await carrier.placeVoiceWithHandshake(voiceCall);

    expect(result.acknowledged).toBe(false);
    // digit still recorded for the audit trail even though it was too late
    expect(result.dtmfDigit).toBe("1");
    expect(result.dtmfAtMs).toBe(20_000);
  });

  it("marks unacknowledged for the wrong DTMF digit", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "fixed",
        outcome: { dtmfDigit: "2", dtmfDelaySec: 3 },
      },
    });

    const result = await carrier.placeVoiceWithHandshake(voiceCall);

    expect(result.acknowledged).toBe(false);
  });

  it("defaults to an unacknowledged TIMEOUT when no plan is given", async () => {
    const carrier = new MockCarrierAdapter({ logger: silentLogger });

    const result = await carrier.placeVoiceWithHandshake(voiceCall);

    expect(result.acknowledged).toBe(false);
    expect(result.amdCode).toBe("TIMEOUT");
    expect(result.dtmfDigit).toBeUndefined();
    expect(result.dtmfAtMs).toBeUndefined();
  });

  it("infers a MACHINE_START AMD code from a scripted voicemail with no digit", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: { mode: "fixed", outcome: { amdCode: "MACHINE_START" } },
    });

    const result = await carrier.placeVoiceWithHandshake(voiceCall);

    expect(result.acknowledged).toBe(false);
    expect(result.amdCode).toBe("MACHINE_START");
  });

  it("consumes a queued script one outcome per call (FIFO) then falls back to TIMEOUT", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "queue",
        outcomes: [
          { amdCode: "SILENCE" }, // 1st call: unacknowledged silence
          { dtmfDigit: "1", dtmfDelaySec: 2 }, // 2nd call: acknowledged
        ],
      },
    });

    const first = await carrier.placeVoiceWithHandshake(voiceCall);
    const second = await carrier.placeVoiceWithHandshake(voiceCall);
    const third = await carrier.placeVoiceWithHandshake(voiceCall);

    expect(first.acknowledged).toBe(false);
    expect(first.amdCode).toBe("SILENCE");
    expect(second.acknowledged).toBe(true);
    expect(second.amdCode).toBe("HUMAN");
    // queue exhausted → safe default
    expect(third.acknowledged).toBe(false);
    expect(third.amdCode).toBe("TIMEOUT");
    expect(carrier.voiceCalls).toHaveLength(3);
  });

  it("supports a callback plan driven by the call target", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "callback",
        fn: (call) =>
          call.to === "+919876543210"
            ? { dtmfDigit: "1", dtmfDelaySec: 5 }
            : { amdCode: "TIMEOUT" },
      },
    });

    const acked = await carrier.placeVoiceWithHandshake(voiceCall);
    const notAcked = await carrier.placeVoiceWithHandshake({
      ...voiceCall,
      to: "+910000000000",
    });

    expect(acked.acknowledged).toBe(true);
    expect(notAcked.acknowledged).toBe(false);
  });

  it("records voice calls with their results and supports reset()", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: { mode: "fixed", outcome: { dtmfDigit: "1", dtmfDelaySec: 1 } },
    });

    await carrier.placeVoiceWithHandshake(voiceCall);
    expect(carrier.voiceCalls).toHaveLength(1);
    expect(carrier.voiceCalls[0]?.call.to).toBe(voiceCall.to);
    expect(carrier.voiceCalls[0]?.result.acknowledged).toBe(true);

    carrier.reset();
    expect(carrier.records).toHaveLength(0);
  });
});

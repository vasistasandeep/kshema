/**
 * {@link MockCarrierAdapter} — a console-logging {@link CarrierAdapter} for
 * unit/integration tests and Simulation_Mode (R25.2, design "Integration tests
 * with mock carrier adapters").
 *
 * Nothing here talks to a real gateway. Every call is logged and recorded in
 * memory so tests can assert what was sent, and the voice-handshake outcome is
 * fully *injectable* — via a queue of scripted results or a callback — so a
 * test (or the dispatch worker under Simulation_Mode) can deterministically
 * drive acknowledged vs unacknowledged calls without any timing flakiness.
 */

import {
  isHandshakeAcknowledged,
  type AmdCode,
  type CarrierAdapter,
  type DeliveryResult,
  type SmsMessage,
  type VoiceHandshakeCall,
  type VoiceHandshakeResult,
  type WhatsAppMessage,
} from "./types.js";

/** A recorded WhatsApp send. */
export interface RecordedWhatsApp {
  kind: "whatsapp";
  msg: WhatsAppMessage;
}

/** A recorded SMS send. */
export interface RecordedSms {
  kind: "sms";
  msg: SmsMessage;
}

/** A recorded voice call plus the result the mock returned for it. */
export interface RecordedVoice {
  kind: "voice";
  call: VoiceHandshakeCall;
  result: VoiceHandshakeResult;
}

/** Any recorded carrier interaction, in call order. */
export type CarrierRecord = RecordedWhatsApp | RecordedSms | RecordedVoice;

/**
 * A scripted voice outcome. Provide the raw handshake inputs and the mock
 * derives `acknowledged` via the shared R31 rule (so a script can't declare an
 * inconsistent acknowledged/DTMF pair). `amdCode` defaults sensibly from the
 * inputs when omitted.
 */
export interface ScriptedVoiceOutcome {
  /** DTMF digit the simulated recipient pressed, if any. */
  dtmfDigit?: string;
  /** Seconds between connect and the DTMF tone, if a digit was pressed. */
  dtmfDelaySec?: number;
  /** Carrier AMD diagnostic; inferred when omitted. */
  amdCode?: AmdCode;
  /** Base epoch-ms for `dtmfAtMs` (defaults to `Date.now()` at call time). */
  connectedAtMs?: number;
}

/**
 * How the mock decides each voice-handshake outcome:
 *   - a fixed {@link ScriptedVoiceOutcome} applied to every call;
 *   - a queue of outcomes consumed one per call (FIFO); or
 *   - a callback computing an outcome from the call.
 * When the queue is exhausted (or no plan is given) the mock defaults to an
 * unacknowledged TIMEOUT — the safe default, since an emergency must never be
 * *falsely* marked acknowledged.
 */
export type VoicePlan =
  | { mode: "fixed"; outcome: ScriptedVoiceOutcome }
  | { mode: "queue"; outcomes: ScriptedVoiceOutcome[] }
  | {
      mode: "callback";
      fn: (call: VoiceHandshakeCall) => ScriptedVoiceOutcome;
    };

/** Construction options for {@link MockCarrierAdapter}. */
export interface MockCarrierAdapterOptions {
  /** Logger; defaults to `console`. */
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** How to resolve voice-handshake outcomes (see {@link VoicePlan}). */
  voicePlan?: VoicePlan;
  /** Whether messaging sends succeed. Defaults to true. */
  deliverySucceeds?: boolean;
}

/** Infer an AMD diagnostic from the raw DTMF inputs when none is scripted. */
function inferAmdCode(outcome: ScriptedVoiceOutcome): AmdCode {
  if (outcome.amdCode) return outcome.amdCode;
  // A confirming digit implies a human answered.
  if (outcome.dtmfDigit !== undefined) return "HUMAN";
  return "TIMEOUT";
}

/**
 * Console-logging, in-memory-recording carrier adapter for tests and
 * Simulation_Mode. Deterministic: voice outcomes come from the injected
 * {@link VoicePlan}, never from wall-clock timing.
 */
export class MockCarrierAdapter implements CarrierAdapter {
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly voicePlan?: VoicePlan;
  private readonly deliverySucceeds: boolean;
  private readonly queue: ScriptedVoiceOutcome[];

  /** All interactions in call order; inspect from tests. */
  readonly records: CarrierRecord[] = [];

  constructor(options: MockCarrierAdapterOptions = {}) {
    this.logger = options.logger ?? console;
    this.voicePlan = options.voicePlan;
    this.deliverySucceeds = options.deliverySucceeds ?? true;
    this.queue =
      options.voicePlan?.mode === "queue"
        ? [...options.voicePlan.outcomes]
        : [];
  }

  async sendWhatsApp(msg: WhatsAppMessage): Promise<DeliveryResult> {
    this.logger.info(
      `[mock-carrier] WhatsApp → ${msg.to} template="${msg.template}" lang=${msg.lang}`,
    );
    this.records.push({ kind: "whatsapp", msg });
    return this.deliveryResult();
  }

  async sendSms(msg: SmsMessage): Promise<DeliveryResult> {
    this.logger.info(`[mock-carrier] SMS → ${msg.to} body="${msg.body}"`);
    this.records.push({ kind: "sms", msg });
    return this.deliveryResult();
  }

  async placeVoiceWithHandshake(
    call: VoiceHandshakeCall,
  ): Promise<VoiceHandshakeResult> {
    const outcome = this.nextOutcome(call);
    const result = this.toResult(call, outcome);
    this.logger.info(
      `[mock-carrier] VOICE → ${call.to} amd=${result.amdCode} ` +
        `dtmf=${result.dtmfDigit ?? "none"} acknowledged=${result.acknowledged}`,
    );
    this.records.push({ kind: "voice", call, result });
    return result;
  }

  /** WhatsApp/SMS sends recorded so far, in order. */
  get sentMessages(): (RecordedWhatsApp | RecordedSms)[] {
    return this.records.filter(
      (r): r is RecordedWhatsApp | RecordedSms => r.kind !== "voice",
    );
  }

  /** Voice calls recorded so far, in order. */
  get voiceCalls(): RecordedVoice[] {
    return this.records.filter((r): r is RecordedVoice => r.kind === "voice");
  }

  /** Clear all recorded interactions (does not reset a queued voice plan). */
  reset(): void {
    this.records.length = 0;
  }

  private deliveryResult(): DeliveryResult {
    return this.deliverySucceeds
      ? { accepted: true, providerId: `mock-${this.records.length}` }
      : { accepted: false, diagnostic: "MOCK_REJECTED" };
  }

  private nextOutcome(call: VoiceHandshakeCall): ScriptedVoiceOutcome {
    const plan = this.voicePlan;
    if (!plan) return {};
    switch (plan.mode) {
      case "fixed":
        return plan.outcome;
      case "callback":
        return plan.fn(call);
      case "queue":
        // Exhausted queue → safe default (unacknowledged TIMEOUT).
        return this.queue.shift() ?? {};
    }
  }

  private toResult(
    call: VoiceHandshakeCall,
    outcome: ScriptedVoiceOutcome,
  ): VoiceHandshakeResult {
    const acknowledged = isHandshakeAcknowledged({
      dtmfDigit: outcome.dtmfDigit,
      dtmfDelaySec: outcome.dtmfDelaySec,
      gatherTimeoutSec: call.gatherTimeoutSec,
    });
    const base: VoiceHandshakeResult = {
      acknowledged,
      amdCode: inferAmdCode(outcome),
    };
    if (outcome.dtmfDigit !== undefined) {
      base.dtmfDigit = outcome.dtmfDigit;
      const connectedAtMs = outcome.connectedAtMs ?? Date.now();
      const delaySec = outcome.dtmfDelaySec ?? 0;
      base.dtmfDelaySec = delaySec;
      base.dtmfAtMs = connectedAtMs + delaySec * 1000;
    }
    return base;
  }
}

/**
 * Carrier abstraction types (task 12.1).
 *
 * WhatsApp (Meta Cloud API) and Twilio/Exotel IVR/SMS are abstracted behind a
 * single {@link CarrierAdapter} interface (design "Integration tests with mock
 * carrier adapters" + "AMD + Interactive Voice Handshake"). The `dispatch`
 * worker (task 12.2) depends only on this interface, so the concrete provider
 * — a live gateway, or the {@link MockCarrierAdapter} used for tests and
 * Simulation_Mode (R25.2) — is a dependency-injection detail.
 *
 * The interface stays deliberately provider-neutral: `to` is an E.164 phone
 * number, and the returned diagnostic codes are normalized carrier-independent
 * strings so the dispatch worker's retry/failover + audit-trail logic (task
 * 12.2, R31.3/R31.4) never has to branch on which vendor answered.
 */

/** Carrier Answering Machine Detection diagnostic (R31, normalized). */
export type AmdCode =
  /** A live human was detected on the line. */
  | "HUMAN"
  /** An answering-machine/voicemail greeting began. */
  | "MACHINE_START"
  /** The line connected but stayed silent. */
  | "SILENCE"
  /** No answer / no confirming tone within the gather window. */
  | "TIMEOUT";

/** The DTMF digit that confirms human presence (R31.2). */
export const HANDSHAKE_CONFIRM_DIGIT = "1" as const;

/** Seconds the recipient has to press the confirm digit (R31.2). */
export const HANDSHAKE_GATHER_TIMEOUT_SEC = 15 as const;

/**
 * Result of a messaging send (WhatsApp or SMS). Provider-neutral: `providerId`
 * is whatever message/SID handle the gateway returns, useful for correlating
 * delivery-status webhooks (R21.13) later.
 */
export interface DeliveryResult {
  /** Whether the gateway accepted the message for delivery. */
  accepted: boolean;
  /** Provider-side message id/SID, when the gateway returns one. */
  providerId?: string;
  /** Normalized diagnostic on rejection (e.g. "INVALID_NUMBER"). */
  diagnostic?: string;
}

/** Options for {@link CarrierAdapter.sendWhatsApp}. */
export interface WhatsAppMessage {
  /** Recipient phone number in E.164 form. */
  to: string;
  /** Approved WhatsApp template name/id. */
  template: string;
  /** BCP-47 / catalog language code (e.g. "en", "hi"). */
  lang: string;
  /** Optional ordered template variable substitutions. */
  variables?: readonly string[];
}

/** Options for {@link CarrierAdapter.sendSms}. */
export interface SmsMessage {
  /** Recipient phone number in E.164 form. */
  to: string;
  /** Plain-text SMS body. */
  body: string;
}

/**
 * Options for {@link CarrierAdapter.placeVoiceWithHandshake} (R31.1/R31.2).
 *
 * `amd` requests carrier Answering Machine Detection; `gatherDigit` +
 * `gatherTimeoutSec` describe the Interactive_Voice_Handshake window in which
 * the recipient must press the confirm digit.
 */
export interface VoiceHandshakeCall {
  /** Recipient phone number in E.164 form. */
  to: string;
  /** Spoken message text (TTS or a pre-rendered clip reference). */
  messageText: string;
  /** Request carrier Answering Machine Detection (R31.1). Always true here. */
  amd: true;
  /** DTMF digit the recipient must press to confirm presence (R31.2). */
  gatherDigit: typeof HANDSHAKE_CONFIRM_DIGIT;
  /** Window, in seconds, to receive the confirming tone (R31.2). */
  gatherTimeoutSec: number;
}

/**
 * Outcome of a voice call with AMD + DTMF handshake (R31).
 *
 * `acknowledged` is authoritative and — per R31 — is true *if and only if* the
 * confirming DTMF digit arrives within the gather window. The raw `dtmfDigit`,
 * `dtmfAtMs`, and `amdCode` are surfaced so the dispatch worker can append the
 * DTMF timestamp + AMD diagnostic to the incident audit trail (R31.4) and so
 * tests can assert the full handshake, not just the boolean.
 */
export interface VoiceHandshakeResult {
  /** True iff DTMF confirm digit received within the gather window (R31). */
  acknowledged: boolean;
  /** Carrier AMD diagnostic code (R31.4). */
  amdCode: AmdCode;
  /** The DTMF digit the recipient pressed, if any. */
  dtmfDigit?: string;
  /**
   * Timestamp of the confirming tone, in epoch milliseconds (R31.4). Present
   * only when a DTMF digit was received. Milliseconds (not a `Date`) keeps the
   * result trivially serializable for the incident audit-trail JSON.
   */
  dtmfAtMs?: number;
  /** Seconds between connection and the DTMF tone, when a digit arrived. */
  dtmfDelaySec?: number;
}

/**
 * Provider-neutral carrier gateway. The `dispatch` worker (task 12.2) depends
 * on this interface only; the concrete adapter is injected.
 */
export interface CarrierAdapter {
  /** Send a templated WhatsApp message (Meta Cloud API in production). */
  sendWhatsApp(msg: WhatsAppMessage): Promise<DeliveryResult>;
  /** Send a plain SMS (Twilio/Exotel in production). */
  sendSms(msg: SmsMessage): Promise<DeliveryResult>;
  /**
   * Place an automated priority voice call with Answering Machine Detection and
   * an Interactive_Voice_Handshake, resolving to a {@link VoiceHandshakeResult}
   * (R31.1–R31.4).
   */
  placeVoiceWithHandshake(
    call: VoiceHandshakeCall,
  ): Promise<VoiceHandshakeResult>;
}

/**
 * Decide acknowledgment from raw handshake inputs, per R31: acknowledged iff
 * the confirm digit was pressed within the gather window. Shared by the mock
 * adapter and reusable by the dispatch worker so the rule lives in exactly one
 * place.
 */
export function isHandshakeAcknowledged(input: {
  dtmfDigit?: string;
  dtmfDelaySec?: number;
  gatherTimeoutSec: number;
}): boolean {
  return (
    input.dtmfDigit === HANDSHAKE_CONFIRM_DIGIT &&
    input.dtmfDelaySec !== undefined &&
    input.dtmfDelaySec <= input.gatherTimeoutSec
  );
}

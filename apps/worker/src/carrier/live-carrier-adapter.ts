/**
 * {@link LiveCarrierAdapter} — production {@link CarrierAdapter} stub wiring the
 * real gateways: Meta WhatsApp Cloud API for messaging, and Twilio/Exotel for
 * SMS + IVR with Answering Machine Detection and DTMF gather (design "Carriers"
 * + "AMD + Interactive Voice Handshake").
 *
 * This is a *shape-only* stub: every method throws so misconfigured production
 * wiring fails loudly instead of silently dropping an emergency call. The real
 * HTTP integration (auth, TwiML/AMD config, DTMF `<Gather>`, delivery-status
 * webhooks) is out of scope for task 12.1 — it lands with the dispatch worker
 * wiring. The class exists now so dependency injection compiles end to end.
 */

import type {
  CarrierAdapter,
  DeliveryResult,
  SmsMessage,
  VoiceHandshakeCall,
  VoiceHandshakeResult,
  WhatsAppMessage,
} from "./types.js";

/** Provider credentials/config for the live gateways (populated later). */
export interface LiveCarrierConfig {
  /** Meta WhatsApp Cloud API access token. */
  whatsAppAccessToken?: string;
  /** Meta WhatsApp Business phone-number id. */
  whatsAppPhoneNumberId?: string;
  /** Twilio/Exotel account SID / api key. */
  voiceAccountSid?: string;
  /** Twilio/Exotel auth token / api secret. */
  voiceAuthToken?: string;
  /** Caller id / from-number for outbound SMS + voice. */
  voiceFromNumber?: string;
}

const NOT_IMPLEMENTED =
  "LiveCarrierAdapter is a stub (task 12.1). Live gateway wiring lands with the dispatch worker (task 12.2).";

/**
 * Live carrier adapter stub. Injecting this satisfies the {@link CarrierAdapter}
 * contract for production DI while the concrete HTTP calls remain TODO.
 */
export class LiveCarrierAdapter implements CarrierAdapter {
  constructor(private readonly config: LiveCarrierConfig = {}) {}

  async sendWhatsApp(_msg: WhatsAppMessage): Promise<DeliveryResult> {
    // TODO(task 12.2): POST to Meta WhatsApp Cloud API /messages with the
    // approved template + language, using this.config.whatsAppAccessToken /
    // whatsAppPhoneNumberId; map the response/message id to DeliveryResult.
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendSms(_msg: SmsMessage): Promise<DeliveryResult> {
    // TODO(task 12.2): POST to Twilio Messages (or Exotel SMS) using
    // this.config.voiceAccountSid / voiceAuthToken / voiceFromNumber; map the
    // SID/status to DeliveryResult.
    throw new Error(NOT_IMPLEMENTED);
  }

  async placeVoiceWithHandshake(
    _call: VoiceHandshakeCall,
  ): Promise<VoiceHandshakeResult> {
    // TODO(task 12.2): originate a call with AmdEnabled and a <Gather num
    // digits=1 timeout=15> collecting DTMF '1'; translate the AMD result +
    // gathered digit + timing into a VoiceHandshakeResult (R31.1–R31.4).
    throw new Error(NOT_IMPLEMENTED);
  }
}

/**
 * Carrier abstraction barrel (task 12.1).
 *
 * The `dispatch` worker (task 12.2) and Simulation_Mode wiring (task 17.1)
 * import the {@link CarrierAdapter} interface and its adapters from here.
 */
export {
  HANDSHAKE_CONFIRM_DIGIT,
  HANDSHAKE_GATHER_TIMEOUT_SEC,
  isHandshakeAcknowledged,
} from "./types.js";
export type {
  AmdCode,
  CarrierAdapter,
  DeliveryResult,
  SmsMessage,
  VoiceHandshakeCall,
  VoiceHandshakeResult,
  WhatsAppMessage,
} from "./types.js";

export { MockCarrierAdapter } from "./mock-carrier-adapter.js";
export type {
  CarrierRecord,
  MockCarrierAdapterOptions,
  RecordedSms,
  RecordedVoice,
  RecordedWhatsApp,
  ScriptedVoiceOutcome,
  VoicePlan,
} from "./mock-carrier-adapter.js";

export { LiveCarrierAdapter } from "./live-carrier-adapter.js";
export type { LiveCarrierConfig } from "./live-carrier-adapter.js";

/**
 * apps/worker — BullMQ Sentinel worker (rhythm eval, escalation FSM,
 * telephony dispatch, resolution, vitality).
 *
 * Foundation (task 8.1): five queues on Redis 7, a deterministic `jobId`
 * scheme (`incident:<id>:stageN`), a job/processor registry (stub processors),
 * event consumers for `telemetry.received` / `ghost.received` aligned with the
 * `apps/api` producer, a graceful-shutdown-capable app factory, and the
 * process entrypoint. Business logic lands in later tasks (8.2, 9.x, 10.x,
 * 12.x, 14.x).
 */
export const WORKER_APP = "@kshema/worker" as const;

export { buildWorkerApp } from "./app.js";
export type { BuildWorkerAppOptions, WorkerApp } from "./app.js";

export { loadEnv } from "./config/env.js";
export type { WorkerEnv } from "./config/env.js";

export {
  QUEUE_NAMES,
  QUEUE_RESPONSIBILITIES,
} from "./queues/definitions.js";
export type { QueueName } from "./queues/definitions.js";

export {
  escalationJobId,
  graceCheckJobId,
  vitalityPulseJobId,
} from "./jobs/job-id.js";
export type { StageNumber } from "./jobs/job-id.js";

export {
  defaultProcessorRegistry,
} from "./jobs/registry.js";
export type {
  JobProcessor,
  ProcessorContext,
  ProcessorRegistry,
} from "./jobs/registry.js";

export {
  EVENT_TARGET_QUEUE,
  createEventsQueueProcessor,
  defaultEventHandlers,
  isSentinelEventName,
} from "./events/consumers.js";
export type {
  EventHandler,
  EventHandlerRegistry,
  SentinelEvent,
  SentinelEventName,
} from "./events/consumers.js";

export {
  REDIS_CONNECTION_OPTIONS,
  createRedisConnection,
} from "./redis.js";

export {
  HANDSHAKE_CONFIRM_DIGIT,
  HANDSHAKE_GATHER_TIMEOUT_SEC,
  isHandshakeAcknowledged,
  MockCarrierAdapter,
  LiveCarrierAdapter,
} from "./carrier/index.js";
export type {
  AmdCode,
  CarrierAdapter,
  DeliveryResult,
  SmsMessage,
  VoiceHandshakeCall,
  VoiceHandshakeResult,
  WhatsAppMessage,
  CarrierRecord,
  MockCarrierAdapterOptions,
  RecordedSms,
  RecordedVoice,
  RecordedWhatsApp,
  ScriptedVoiceOutcome,
  VoicePlan,
  LiveCarrierConfig,
} from "./carrier/index.js";

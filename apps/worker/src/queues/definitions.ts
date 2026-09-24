/**
 * The five Sentinel worker queues (design "apps/worker — BullMQ queues").
 *
 * Each queue owns one slice of the incident lifecycle. This module names them
 * and describes their responsibility; the actual business logic lands in later
 * tasks (referenced per-queue below). Keeping the names in one typed place
 * means producers, consumers, and the job registry can never drift.
 */

/** Canonical queue names. Order is the natural incident lifecycle order. */
export const QUEUE_NAMES = [
  "rhythm-eval",
  "escalation",
  "dispatch",
  "resolution",
  "vitality",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Human-readable responsibility per queue (for docs/logging/introspection). */
export const QUEUE_RESPONSIBILITIES: Record<QueueName, string> = {
  "rhythm-eval":
    "Nightly per-Anchor Grace_Deadline computation + delayed grace-check scheduling (task 8.2 / 9.1)",
  escalation:
    "Four-stage escalation FSM; each stage schedules the next as a delayed job (task 10.1)",
  dispatch:
    "Telephony/messaging fan-out (WhatsApp, SMS, IVR) with retry + AMD/DTMF handshake (task 12.x, 13.x)",
  resolution:
    "Consumes resolution events; transitions incidents and cancels pending escalation jobs (task 10.3)",
  vitality: "Emits Vitality Pulses and increments streaks (task 14.x)",
};

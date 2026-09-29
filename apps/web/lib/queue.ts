import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * Server-only BullMQ producer for driving real Sentinel incidents from the web
 * app (demo/simulation). Connects to the same Redis the worker consumes. The
 * worker's escalation queue accepts an \"open\" job that opens a real STAGE_1
 * SafetyIncident in Postgres, which the live Observer dashboard then reflects.
 */
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let escalationQueue: Queue | null = null;

export function getEscalationQueue(): Queue {
  if (!escalationQueue) {
    const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    escalationQueue = new Queue("escalation", { connection });
  }
  return escalationQueue;
}

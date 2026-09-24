/**
 * apps/worker — environment-driven configuration.
 *
 * The Sentinel worker is a long-lived process that consumes BullMQ jobs off
 * Redis 7. Every runtime knob (Redis URL, the events queue name it shares with
 * `apps/api`, concurrency) is sourced from the environment and validated once
 * at startup with Zod so a misconfiguration fails fast with a descriptive
 * error.
 *
 * The Redis connection is intentionally *lazy* (see `redis.ts`): the worker
 * app factory can construct all five queues and be closed again without a
 * reachable Redis, which keeps the unit tests hermetic.
 *
 * `EVENTS_QUEUE_NAME` MUST match the value used by `apps/api`
 * (`apps/api/src/config/env.ts`) so the producer and consumer align on the
 * same queue — the API emits `telemetry.received` / `ghost.received` jobs onto
 * it and this worker consumes them.
 */
import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    /** BullMQ / ioredis connection string. Matches apps/api. */
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

    /**
     * Queue the API emits domain events onto (telemetry.received,
     * ghost.received, …). MUST match `EVENTS_QUEUE_NAME` in apps/api so the
     * producer and this consumer align.
     */
    EVENTS_QUEUE_NAME: z.string().min(1).default("sentinel-events"),

    /** Number of jobs a worker processes concurrently. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(8),
  })
  .transform((raw) => ({ ...raw }));

export type WorkerEnv = z.infer<typeof EnvSchema>;

/**
 * Parse and validate the environment. Throws a descriptive error on a bad
 * configuration. Accepts an override object so tests can inject a config
 * without mutating `process.env`.
 */
export function loadEnv(overrides: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = EnvSchema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid worker environment configuration: ${issues}`);
  }
  return parsed.data;
}

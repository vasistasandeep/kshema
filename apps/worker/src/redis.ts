/**
 * ioredis connection factory for the Sentinel worker.
 *
 * Mirrors the connection conventions in `apps/api/src/plugins/events.ts` so the
 * producer (API) and consumer (this worker) behave identically against Redis 7:
 *   - `lazyConnect: true` — no socket is opened until the first command, so the
 *     worker app factory can construct all queues/workers and be closed again
 *     without a reachable Redis (hermetic tests, safe boot).
 *   - `maxRetriesPerRequest: null` — required by BullMQ for its blocking
 *     commands and avoids unbounded retry storms when Redis is unreachable.
 *   - `enableReadyCheck: false` — same rationale as the API producer.
 *
 * A connection-level `error` handler is attached so an unreachable Redis never
 * crashes the process at boot; job processing surfaces errors per-job instead.
 */
import { Redis, type RedisOptions } from "ioredis";

export const REDIS_CONNECTION_OPTIONS: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * Create a lazily-connecting ioredis client for the given URL. The returned
 * client will not open a socket until first use.
 */
export function createRedisConnection(redisUrl: string): Redis {
  const connection = new Redis(redisUrl, REDIS_CONNECTION_OPTIONS);
  // Swallow connection errors so an unreachable Redis never crashes boot.
  connection.on("error", () => undefined);
  return connection;
}

/**
 * Redis / BullMQ event producer plugin.
 *
 * The API is a *producer*: routes emit domain events (e.g. `telemetry.received`,
 * `ghost.received`) onto a BullMQ queue that the Sentinel worker consumes
 * (see design "apps/worker — BullMQ queues"). This plugin decorates the app
 * with `app.events`, a small typed helper wrapping a BullMQ `Queue`.
 *
 * Two design constraints from the task:
 *   1. Config is env-driven (REDIS_URL / EVENTS_QUEUE_NAME).
 *   2. The connection is *lazy* and *injectable* so tests — and the `/health`
 *      smoke path — run with no live Redis. ioredis is created with
 *      `lazyConnect: true`, and `emit()` is a no-op-safe call that surfaces
 *      connection errors to the caller rather than crashing boot. Tests may
 *      inject a fake emitter entirely.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";

/** Domain events the API produces for the Sentinel worker. */
export type SentinelEventName =
  | "telemetry.received"
  | "ghost.received"
  | "incident.resolved"
  | "sos.triggered"
  // Emitted when an admin (SUPPORT_AGENT/SUPER_ADMIN) manually triggers an
  // alternate carrier fallback dispatch for a failed dispatch during an active
  // incident (task 19.1, R21.12). The worker performs the actual re-dispatch.
  | "incident.retry-dispatch"
  // Emitted when a Circle's Subscription_Tier changes (task 15.1, R20.8/R20.4).
  // The worker consumes this to RESUME routines on a move into PRO/TRIAL and to
  // SUSPEND them on a move into SHIELD_PAUSED (worker gate is task 15.2).
  | "subscription.changed";

export interface SentinelEvent<T = unknown> {
  name: SentinelEventName;
  payload: T;
}

/** Minimal producer surface the rest of the API depends on. */
export interface EventEmitter {
  /** Enqueue a domain event as a BullMQ job named after the event. */
  emit<T>(name: SentinelEventName, payload: T): Promise<void>;
  /** Release the underlying connection. */
  close(): Promise<void>;
}

export interface EventsPluginOptions {
  redisUrl: string;
  queueName: string;
  /**
   * Inject a ready-made emitter (tests use this to avoid a live Redis).
   * When provided, no ioredis connection is created.
   */
  emitter?: EventEmitter;
}

declare module "fastify" {
  interface FastifyInstance {
    events: EventEmitter;
  }
}

/**
 * A BullMQ-backed emitter. The Redis connection uses `lazyConnect` so no
 * socket is opened until the first `emit()`; `buildApp()` therefore never
 * requires a reachable Redis.
 */
class BullmqEventEmitter implements EventEmitter {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(redisUrl: string, queueName: string) {
    const options: RedisOptions = {
      lazyConnect: true,
      // BullMQ requires this for blocking commands; also avoids unbounded
      // retry storms when Redis is unreachable in dev/test.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
    this.connection = new Redis(redisUrl, options);
    // Swallow connection errors so an unreachable Redis never crashes the
    // process at boot; emit() will still reject and let the caller decide.
    this.connection.on("error", () => undefined);
    this.queue = new Queue(queueName, { connection: this.connection });
  }

  async emit<T>(name: SentinelEventName, payload: T): Promise<void> {
    await this.queue.add(name, { name, payload } satisfies SentinelEvent<T>, {
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }
}

async function eventsPlugin(
  app: FastifyInstance,
  opts: EventsPluginOptions,
): Promise<void> {
  const emitter: EventEmitter =
    opts.emitter ?? new BullmqEventEmitter(opts.redisUrl, opts.queueName);

  if (!app.hasDecorator("events")) {
    app.decorate("events", emitter);
  }

  app.addHook("onClose", async () => {
    // Only close a connection this plugin created; an injected emitter is
    // owned by the test.
    if (!opts.emitter) {
      await emitter.close();
    }
  });
}

export default fp(eventsPlugin, {
  name: "kshema-events",
});

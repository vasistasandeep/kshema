/**
 * Sentinel worker app factory.
 *
 * `buildWorkerApp()` assembles the whole BullMQ surface without requiring a
 * reachable Redis, so it is directly injectable in tests:
 *   - a shared ioredis connection (lazyConnect — no socket until first use);
 *   - a `Queue` + `Worker` pair for each of the five Sentinel queues, each
 *     wired to its processor from the registry;
 *   - a consumer `Worker` on the shared events queue that routes
 *     `telemetry.received` / `ghost.received` (and the other domain events) to
 *     their handlers — aligning with how `apps/api` emits (single queue named
 *     `EVENTS_QUEUE_NAME`, job name = event name, data = `{ name, payload }`).
 *
 * All dependencies (env, Prisma client, Redis connection, processor + handler
 * registries, logger) are injectable so tests build and close the app with no
 * live Redis or DB. `close()` performs graceful shutdown, closing every worker
 * and queue and quitting the connection.
 */
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

import { prisma as defaultPrisma, type PrismaClient } from "@kshema/database";

import { loadEnv, type WorkerEnv } from "./config/env.js";
import { createRedisConnection } from "./redis.js";
import { QUEUE_NAMES, type QueueName } from "./queues/definitions.js";
import {
  buildDefaultProcessorRegistry,
  type ProcessorContext,
  type ProcessorRegistry,
} from "./jobs/registry.js";
import {
  createEventsQueueProcessor,
  buildDefaultEventHandlers,
  type EventHandlerRegistry,
} from "./events/consumers.js";
import { createInMemoryGraceCheckStore } from "./personas/rhythm-eval.js";

export interface BuildWorkerAppOptions {
  /** Pre-parsed env; defaults to parsing `process.env`. */
  env?: WorkerEnv;
  /** Inject a Prisma client (tests avoid a live DB). */
  prisma?: PrismaClient;
  /** Inject a Redis connection (tests avoid a live Redis). */
  connection?: Redis;
  /** Override queue processors (tests avoid real side-effects). */
  processors?: ProcessorRegistry;
  /** Override event handlers (tests avoid real side-effects). */
  eventHandlers?: EventHandlerRegistry;
  /** Structured logger; defaults to `console`. */
  logger?: Pick<Console, "info" | "warn" | "error">;
  /**
   * Start `Worker` processing loops. Defaults to `false` so constructing the
   * app in a test never opens a Redis socket. Set `true` in `server.ts` to
   * actually consume jobs.
   */
  autorun?: boolean;
}

export interface WorkerApp {
  readonly env: WorkerEnv;
  /** The five processing queues, keyed by name. */
  readonly queues: Record<QueueName, Queue>;
  /** The five queue workers, keyed by name. */
  readonly workers: Record<QueueName, Worker>;
  /** The consumer worker on the shared events queue. */
  readonly eventsWorker: Worker;
  /** The shared events queue (same name the API produces onto). */
  readonly eventsQueue: Queue;
  /** Gracefully close every worker/queue and (optionally) the connection. */
  close(): Promise<void>;
}

export function buildWorkerApp(
  options: BuildWorkerAppOptions = {},
): WorkerApp {
  const env = options.env ?? loadEnv();
  const logger = options.logger ?? console;
  const prisma = options.prisma ?? defaultPrisma;
  // Share one grace-check state store between the rhythm-eval processor and the
  // confirming-signal event handlers so a confirming telemetry/ghost signal
  // mutates the same pending state the grace-check later reads (R5.6/R6.4/R6.5).
  const graceCheckStore = createInMemoryGraceCheckStore();
  const processors =
    options.processors ?? buildDefaultProcessorRegistry({ store: graceCheckStore });
  const eventHandlers =
    options.eventHandlers ?? buildDefaultEventHandlers({ store: graceCheckStore });
  const autorun = options.autorun ?? false;

  // A test may inject its own connection; only a connection we created is ours
  // to quit on close.
  const ownsConnection = options.connection === undefined;
  const connection = options.connection ?? createRedisConnection(env.REDIS_URL);

  const ctx: ProcessorContext = { prisma, logger };

  const workerOpts = {
    connection,
    concurrency: env.WORKER_CONCURRENCY,
    // Do not open the blocking Redis connection until explicitly run.
    autorun,
  } as const;

  // One Queue + Worker per Sentinel queue.
  const queues = {} as Record<QueueName, Queue>;
  const workers = {} as Record<QueueName, Worker>;

  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue(name, { connection });
    const processor = processors[name];
    workers[name] = new Worker(
      name,
      async (job: Job) => processor(job, ctx),
      workerOpts,
    );
    workers[name].on("error", (err) =>
      logger.error(`[worker:${name}] worker error`, err),
    );
  }

  // Consumer on the shared events queue the API produces onto.
  const eventsQueue = new Queue(env.EVENTS_QUEUE_NAME, { connection });
  const eventsProcessor = createEventsQueueProcessor(eventHandlers);
  const eventsWorker = new Worker(
    env.EVENTS_QUEUE_NAME,
    async (job: Job) => eventsProcessor({ name: job.name, data: job.data }, ctx),
    workerOpts,
  );
  eventsWorker.on("error", (err) =>
    logger.error(`[worker:events] worker error`, err),
  );

  async function close(): Promise<void> {
    // Close workers first (stop pulling jobs), then queues, then the
    // connection we own. Each close is guarded so one failure never blocks the
    // rest of the graceful shutdown.
    await Promise.all(
      Object.values(workers).map((w) => w.close().catch(() => undefined)),
    );
    await eventsWorker.close().catch(() => undefined);
    await Promise.all(
      Object.values(queues).map((q) => q.close().catch(() => undefined)),
    );
    await eventsQueue.close().catch(() => undefined);
    if (ownsConnection) {
      await connection.quit().catch(() => undefined);
    }
  }

  return { env, queues, workers, eventsWorker, eventsQueue, close };
}

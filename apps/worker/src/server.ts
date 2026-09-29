/**
 * apps/worker entrypoint.
 *
 * Boots the Sentinel worker with autorun and injects the production Prisma +
 * BullMQ wiring for every queue (escalation, resolution, dispatch, vitality)
 * plus the resolution event handlers, so the whole incident lifecycle is
 * persisted end-to-end. SIMULATION_MODE compresses the stage interval.
 */
import { Queue } from "bullmq";
import { buildWorkerApp } from "./app.js";
import { QUEUE_NAMES } from "./queues/definitions.js";
import { loadEnv } from "./config/env.js";
import { createRedisConnection } from "./redis.js";
import { prisma } from "@kshema/database";
import { buildDefaultProcessorRegistry } from "./jobs/registry.js";
import { buildDefaultEventHandlers } from "./events/consumers.js";
import { createInMemoryGraceCheckStore } from "./personas/rhythm-eval.js";
import {
  buildPrismaEscalationDeps,
  buildPrismaResolutionDeps,
  buildPrismaDispatchDeps,
  buildPrismaVitalityDeps,
  type Wiring,
} from "./wiring/escalation-prisma.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const connection = createRedisConnection(env.REDIS_URL);

  const escalationQueue = new Queue("escalation", { connection });
  const dispatchQueue = new Queue("dispatch", { connection });

  const simulation = process.env.SIMULATION_MODE === "true";
  const stageIntervalMs = simulation ? 8000 : undefined;

  const wiring: Wiring = {
    prisma, escalationQueue, dispatchQueue,
    ...(stageIntervalMs !== undefined ? { stageIntervalMs } : {}),
  };

  const store = createInMemoryGraceCheckStore();
  const processors = buildDefaultProcessorRegistry({
    store,
    escalation: buildPrismaEscalationDeps(wiring),
    resolution: buildPrismaResolutionDeps(wiring),
    dispatch: buildPrismaDispatchDeps(wiring),
    vitality: buildPrismaVitalityDeps(wiring),
  });

  // Resolution event handlers so API-emitted incident.resolved / sos.triggered
  // events atomically resolve/hand off the incident.
  const eventHandlers = buildDefaultEventHandlers({
    store,
    resolution: buildPrismaResolutionDeps(wiring),
  });

  const app = buildWorkerApp({ autorun: true, connection, processors, eventHandlers, prisma });

  // eslint-disable-next-line no-console
  console.info(
    `[worker] Sentinel worker started — queues: ${QUEUE_NAMES.join(", ")}; all queues Prisma-backed${simulation ? " (SIMULATION: 8s/stage)" : ""}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.info(`[worker] received ${signal}, shutting down gracefully…`);
    await escalationQueue.close().catch(() => undefined);
    await dispatchQueue.close().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal error during startup", err);
  process.exit(1);
});

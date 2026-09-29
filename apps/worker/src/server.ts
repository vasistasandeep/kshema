/**
 * apps/worker entrypoint.
 *
 * Boots the Sentinel worker with autorun so BullMQ workers consume jobs, and
 * injects the production Prisma + BullMQ wiring for the escalation queue so
 * opening an incident persists a real SafetyIncident (which the Observer
 * dashboard reflects). Other queues keep their default processors until wired.
 */
import { Queue } from "bullmq";
import { buildWorkerApp } from "./app.js";
import { QUEUE_NAMES } from "./queues/definitions.js";
import { loadEnv } from "./config/env.js";
import { createRedisConnection } from "./redis.js";
import { prisma } from "@kshema/database";
import { buildDefaultProcessorRegistry } from "./jobs/registry.js";
import { buildPrismaEscalationDeps } from "./wiring/escalation-prisma.js";
import { createInMemoryGraceCheckStore } from "./personas/rhythm-eval.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const connection = createRedisConnection(env.REDIS_URL);

  // Queues used by the Prisma escalation seams (advance scheduling + dispatch).
  const escalationQueue = new Queue("escalation", { connection });
  const dispatchQueue = new Queue("dispatch", { connection });

  // Compress stage interval when SIMULATION_MODE is on so a demo advances in
  // seconds rather than the production 20 minutes (R25.1).
  const simulation = process.env.SIMULATION_MODE === "true";
  const stageIntervalMs = simulation ? 8000 : undefined;

  const store = createInMemoryGraceCheckStore();
  const processors = buildDefaultProcessorRegistry({
    store,
    escalation: buildPrismaEscalationDeps({
      prisma,
      escalationQueue,
      dispatchQueue,
      ...(stageIntervalMs !== undefined ? { stageIntervalMs } : {}),
    }),
  });

  const app = buildWorkerApp({ autorun: true, connection, processors, prisma });

  // eslint-disable-next-line no-console
  console.info(
    `[worker] Sentinel worker started — queues: ${QUEUE_NAMES.join(", ")}; events queue: ${app.env.EVENTS_QUEUE_NAME}; escalation=Prisma-backed${simulation ? " (SIMULATION: 8s/stage)" : ""}`,
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

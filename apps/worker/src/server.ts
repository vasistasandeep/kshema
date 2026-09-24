/**
 * apps/worker entrypoint.
 *
 * Boots the Sentinel worker with `autorun: true` so the BullMQ workers begin
 * consuming jobs, and installs graceful-shutdown handlers that close every
 * worker/queue and the Redis connection on SIGINT/SIGTERM.
 */
import { buildWorkerApp } from "./app.js";
import { QUEUE_NAMES } from "./queues/definitions.js";

async function main(): Promise<void> {
  const app = buildWorkerApp({ autorun: true });

  // eslint-disable-next-line no-console
  console.info(
    `[worker] Sentinel worker started — queues: ${QUEUE_NAMES.join(", ")}; events queue: ${app.env.EVENTS_QUEUE_NAME}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.info(`[worker] received ${signal}, shutting down gracefully…`);
    await app.close();
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal error during startup", err);
  process.exit(1);
});

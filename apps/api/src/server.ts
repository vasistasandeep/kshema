/**
 * Server entrypoint.
 *
 * Parses the environment, builds the app, binds the socket, and installs
 * graceful-shutdown handlers so in-flight requests drain and the Prisma /
 * Redis connections close cleanly on SIGINT / SIGTERM (important for the
 * always-on deployment that also serves long-lived SSE streams).
 */
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main();

/**
 * Prisma client injection plugin.
 *
 * Decorates the Fastify instance with `app.prisma`, sourced from the shared
 * `@kshema/database` singleton so the whole platform shares one typed
 * data-access surface and one connection pool (R19.1, R19.3 — the client can
 * never decrypt Flight Recorder payloads).
 *
 * The client is injectable: tests (and the smoke test in particular) pass a
 * fake/stub via options so the app boots without a live database. Connection
 * is lazy — Prisma connects on first query, so `buildApp()` + `/health` never
 * require Postgres to be reachable.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { prisma as defaultPrisma, type PrismaClient } from "@kshema/database";

export interface PrismaPluginOptions {
  /** Override the client (used by tests to avoid a live DB). */
  prisma?: PrismaClient;
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function prismaPlugin(
  app: FastifyInstance,
  opts: PrismaPluginOptions,
): Promise<void> {
  const client = opts.prisma ?? defaultPrisma;

  if (!app.hasDecorator("prisma")) {
    app.decorate("prisma", client);
  }

  app.addHook("onClose", async () => {
    // Only disconnect the shared singleton — an injected test client owns its
    // own lifecycle.
    if (!opts.prisma) {
      await client.$disconnect().catch(() => undefined);
    }
  });
}

export default fp(prismaPlugin, {
  name: "kshema-prisma",
});

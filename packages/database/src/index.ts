/**
 * @kshema/database — Prisma schema, generated client, and migrations.
 *
 * Exposes a single lazily-instantiated, hot-reload-safe `PrismaClient`
 * singleton plus a re-export of the generated Prisma types/enums so every
 * app and package shares one typed data-access surface.
 *
 * Privacy posture (R8.6, R19.1, R19.3): the client has no ability to decrypt
 * Flight Recorder payloads — `EncryptedBlackBox` stores ciphertext only and no
 * private key is ever persisted. `TelemetryLog` carries no continuous-location
 * column by construction.
 */
export * from "@prisma/client";
export { Prisma, PrismaClient } from "@prisma/client";

import { PrismaClient } from "@prisma/client";

export const DATABASE_PACKAGE = "@kshema/database" as const;

/**
 * Options used to construct the shared client. Kept minimal; individual apps
 * may construct their own `PrismaClient` if they need bespoke logging.
 */
const clientOptions = {
  log:
    process.env.NODE_ENV === "development"
      ? (["warn", "error"] as const)
      : (["error"] as const),
} satisfies ConstructorParameters<typeof PrismaClient>[0];

// Reuse a single instance across hot reloads in dev to avoid exhausting the
// PostgreSQL connection pool.
const globalForPrisma = globalThis as unknown as {
  __kshemaPrisma?: PrismaClient;
};

/**
 * The shared, typed Prisma client singleton.
 */
export const prisma: PrismaClient =
  globalForPrisma.__kshemaPrisma ?? new PrismaClient(clientOptions);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__kshemaPrisma = prisma;
}

export default prisma;

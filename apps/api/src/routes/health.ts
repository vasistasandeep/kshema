/**
 * Health-check route — a smoke target that proves the app booted, plugins
 * registered, and the Zod type provider is wired. It performs no DB/Redis I/O
 * so it stays green even without live infrastructure.
 *
 * Mounted under the `/api/v1` prefix, so the effective path is
 * `GET /api/v1/health`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("@kshema/api"),
    time: z.string().datetime({ offset: true }),
  })
  .strict();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({
      status: "ok" as const,
      service: "@kshema/api" as const,
      time: new Date().toISOString(),
    }),
  );
}

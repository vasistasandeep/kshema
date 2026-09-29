/**
 * DEV-ONLY auth route (non-production).
 *
 * Mints a real session for a phone number WITHOUT the SMS OTP round-trip, so
 * local clients (mobile dev build, web) can log in end-to-end without reading
 * the dev SMS log. Registered only when NODE_ENV !== "production"; in
 * production this route does not exist and the real OTP flow is the only path.
 *
 * Effective path: POST /api/v1/auth/dev/login  { phone, preferredName?, timezone?, clientPublicKeyPem? }
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const DEV_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALc3REPLACE\n-----END PUBLIC KEY-----\n";

const DevLoginBody = z
  .object({
    phone: z.string().trim().min(3),
    preferredName: z.string().trim().min(1).optional(),
    timezone: z.string().trim().min(1).default("Asia/Kolkata"),
    clientPublicKeyPem: z.string().trim().min(1).optional(),
  })
  .strict();

const DevLoginResponse = z
  .object({
    userId: z.string(),
    accessToken: z.string(),
  })
  .strict();

export async function devAuthRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/auth/dev/login",
    { schema: { body: DevLoginBody, response: { 200: DevLoginResponse } } },
    async (request) => {
      const { phone, preferredName, timezone, clientPublicKeyPem } = request.body;
      const user = await app.prisma.user.upsert({
        where: { phone },
        create: {
          phone,
          publicKeyPem: clientPublicKeyPem ?? DEV_PUBLIC_KEY_PEM,
          timezone,
          ...(preferredName ? { preferredName } : {}),
          pushTokens: [],
        },
        update: {
          ...(clientPublicKeyPem ? { publicKeyPem: clientPublicKeyPem } : {}),
          timezone,
          ...(preferredName ? { preferredName } : {}),
        },
        select: { id: true },
      });
      const accessToken = app.jwt.sign({ sub: user.id, channel: "MOBILE" });
      return { userId: user.id, accessToken };
    },
  );
}

/**
 * OTP auth & identity routes (R1.1, R1.2, R1.3, R1.5, R1.6, R1.8).
 *
 * Mounted under `/api/v1`, so effective paths are:
 *   - `POST /api/v1/auth/otp/request`
 *   - `POST /api/v1/auth/otp/verify`
 *
 * `otp/request` generates an OTP, stores only a HASHED digest + expiry in the
 * challenge store, dispatches the code via the injected `SmsSender`, and
 * returns `{ challengeId }` (R1.1).
 *
 * `otp/verify` validates the submitted code against the stored hash and expiry;
 * on success it upserts the `User` — persisting `publicKeyPem`, `timezone`,
 * `preferredName`, and the push token (R1.2, R1.5, R1.6) — and issues a JWT
 * access + refresh token pair. A wrong or expired code is rejected with a
 * descriptive 401 (R1.3). The request accepts ONLY `clientPublicKeyPem`; the
 * `.strict()` Zod schema in `@kshema/types` structurally rejects any private
 * key (R1.8).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AuthSessionSchema,
  OtpRequestResponseSchema,
  OtpRequestSchema,
  OtpVerifySchema,
} from "@kshema/types";

import type { AccessTokenPayload } from "../plugins/auth.js";
import type { SmsSender } from "../services/sms.js";
import {
  generateOtp,
  generateOtpSalt,
  hashOtp,
  verifyOtp,
} from "../services/otp-crypto.js";
import type { OtpChallengeStore, OtpChannel } from "../services/otp-store.js";

/** Dependencies injected into the auth routes (all replaceable in tests). */
export interface AuthRouteDeps {
  /** Challenge store (Redis in prod, in-memory in tests). */
  otpStore: OtpChallengeStore;
  /** SMS transport used to deliver the OTP. */
  smsSender: SmsSender;
  /** Server-side secret binding OTP digests to this deployment. */
  otpSecret: string;
  /** OTP lifetime in milliseconds (default 5 minutes). */
  otpTtlMs?: number;
  /** Access-token lifetime, as an `@fastify/jwt` `expiresIn` string. */
  accessTokenTtl?: string;
  /** Refresh-token lifetime, as an `@fastify/jwt` `expiresIn` string. */
  refreshTokenTtl?: string;
  /** Login channel these routes issue sessions for. */
  channel?: OtpChannel;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/** Descriptive error envelope for the 401 rejection path (R1.3). */
const AuthErrorSchema = z
  .object({
    error: z.literal("Unauthorized"),
    message: z.string().min(1),
  })
  .strict();

const DEFAULT_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ACCESS_TTL = "15m";
const DEFAULT_REFRESH_TTL = "30d";
const ACCESS_TTL_SECONDS = 15 * 60;

export async function authRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  const {
    otpStore,
    smsSender,
    otpSecret,
    otpTtlMs = DEFAULT_OTP_TTL_MS,
    accessTokenTtl = DEFAULT_ACCESS_TTL,
    refreshTokenTtl = DEFAULT_REFRESH_TTL,
    channel = "MOBILE",
    now = Date.now,
  } = deps;

  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /auth/otp/request — generate + hash + store + dispatch (R1.1).
  typed.post(
    "/auth/otp/request",
    {
      schema: {
        body: OtpRequestSchema,
        response: { 200: OtpRequestResponseSchema },
      },
    },
    async (request) => {
      const { phone } = request.body;

      const code = generateOtp();
      const salt = generateOtpSalt();
      const codeHash = hashOtp(code, salt, otpSecret);
      const expiresAt = now() + otpTtlMs;

      const challengeId = await otpStore.create({
        phone,
        codeHash,
        salt,
        expiresAt,
        channel,
      });

      // Plaintext code leaves the server only over the SMS transport; it is
      // never persisted (R1.3).
      await smsSender.send({
        to: phone,
        body: `Your Kshema verification code is ${code}. It expires in ${Math.round(
          otpTtlMs / 60000,
        )} minutes.`,
      });

      return { challengeId };
    },
  );

  // POST /auth/otp/verify — validate + upsert User + issue tokens (R1.2/1.5/1.6),
  // reject wrong/expired with a descriptive 401 (R1.3). Accepts only the public
  // key (R1.8, enforced by the `.strict()` schema).
  typed.post(
    "/auth/otp/verify",
    {
      schema: {
        body: OtpVerifySchema,
        response: { 200: AuthSessionSchema, 401: AuthErrorSchema },
      },
    },
    async (request, reply) => {
      const {
        challengeId,
        code,
        clientPublicKeyPem,
        preferredName,
        timezone,
        pushToken,
      } = request.body;

      const challenge = await otpStore.get(challengeId);

      // Absent/expired challenge, or a code mismatch, are all authentication
      // failures. Respond with a single descriptive 401 that does not reveal
      // which condition failed (avoids an enumeration oracle) (R1.3).
      const invalid = () =>
        reply.code(401).send({
          error: "Unauthorized",
          message: "The verification code is incorrect or has expired.",
        });

      if (!challenge) {
        return invalid();
      }

      // Defense in depth: the store already treats expired entries as absent,
      // but re-check against the injected clock.
      if (challenge.expiresAt <= now()) {
        await otpStore.consume(challengeId);
        return invalid();
      }

      const codeMatches = verifyOtp(
        code,
        challenge.salt,
        otpSecret,
        challenge.codeHash,
      );
      if (!codeMatches) {
        return invalid();
      }

      // Single-use: consume the challenge before issuing a session so a code
      // cannot be replayed.
      await otpStore.consume(challengeId);

      // Upsert the User, persisting public key / timezone / preferred name /
      // push token (R1.2, R1.5, R1.6). Only the PUBLIC key is stored (R1.8).
      const pushTokens = pushToken ? [pushToken] : [];
      const user = await app.prisma.user.upsert({
        where: { phone: challenge.phone },
        create: {
          phone: challenge.phone,
          publicKeyPem: clientPublicKeyPem,
          timezone,
          ...(preferredName ? { preferredName } : {}),
          pushTokens,
        },
        update: {
          publicKeyPem: clientPublicKeyPem,
          timezone,
          ...(preferredName ? { preferredName } : {}),
          ...(pushToken ? { pushTokens: { push: pushToken } } : {}),
        },
      });

      const payload: AccessTokenPayload = { sub: user.id, channel };
      const accessToken = app.jwt.sign(payload, { expiresIn: accessTokenTtl });
      const refreshToken = app.jwt.sign(
        { ...payload, typ: "refresh" } satisfies AccessTokenPayload,
        { expiresIn: refreshTokenTtl },
      );

      return {
        userId: user.id,
        accessToken,
        refreshToken,
        expiresAt: new Date(now() + ACCESS_TTL_SECONDS * 1000).toISOString(),
      };
    },
  );
}

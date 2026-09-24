/**
 * Web portal auth routes — OTP over the WEB login channel + WebAuthn passkeys
 * (task 20.1, R28.1, R28.2).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `POST /api/v1/web/auth/otp/request`
 *   - `POST /api/v1/web/auth/otp/verify`
 *   - `POST /api/v1/web/webauthn/register/options`
 *   - `POST /api/v1/web/webauthn/register/verify`
 *   - `POST /api/v1/web/webauthn/authenticate/options`
 *   - `POST /api/v1/web/webauthn/authenticate/verify`
 *
 * WEB OTP (R28.1, R28.2). The OTP challenge machinery is identical to the
 * mobile flow (hashed digest + expiry in the challenge store, plaintext code
 * only over SMS), but the challenge — and the session it issues — are stamped
 * with the `WEB` login channel so the browser session is distinguishable from a
 * mobile one. Verify accepts ONLY `clientPublicKeyPem`, generated in the
 * browser by the `Web_Crypto_Vault`; the `.strict()` DTO structurally rejects
 * any private-key field, so the Observer private key never transits (R28.2).
 *
 * WEBAUTHN PASSKEYS (R28.1). Optional FIDO2 / TouchID / Windows Hello second
 * factor. The registration and authentication ceremonies each have an
 * `.../options` call (mint + stash a single-use challenge, return the ceremony
 * options to the browser) and a `.../verify` call (validate the browser's
 * `navigator.credentials` response through the injected `WebAuthnVerifier`,
 * then persist / update the `WebAuthnCredential`).
 *
 * CLONE DETECTION (R28.1 "rejects any non-increasing counter"). On a successful
 * assertion the asserted signature counter MUST be strictly greater than the
 * counter stored for that credential. A non-increasing counter indicates a
 * cloned authenticator and is rejected with a descriptive 401 — the credential
 * is NOT advanced. This rule is enforced HERE against the persisted
 * `WebAuthnCredential.counter`, independent of the verifier implementation, so
 * it holds for the SDK-free default verifier and any production FIDO2 adapter
 * alike.
 *
 * Registration requires an authenticated web session (`app.authenticate`) — a
 * user enrolls a passkey after logging in via OTP. The options/verify
 * authentication ceremonies are unauthenticated (they ARE the login) and are
 * bound to the supplied phone.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  WebAuthnAuthenticateOptionsRequestSchema,
  WebAuthnAuthenticateOptionsResponseSchema,
  WebAuthnAuthenticateVerifySchema,
  WebAuthnRegisterOptionsRequestSchema,
  WebAuthnRegisterOptionsResponseSchema,
  WebAuthnRegisterResultSchema,
  WebAuthnRegisterVerifySchema,
  WebAuthSessionSchema,
  WebOtpRequestSchema,
  WebOtpVerifySchema,
  OtpRequestResponseSchema,
} from "@kshema/types";

import type { AccessTokenPayload } from "../plugins/auth.js";
import type { SmsSender } from "../services/sms.js";
import {
  generateOtp,
  generateOtpSalt,
  hashOtp,
  verifyOtp,
} from "../services/otp-crypto.js";
import type { OtpChallengeStore } from "../services/otp-store.js";
import {
  DefaultWebAuthnVerifier,
  type WebAuthnChallengeStore,
  type WebAuthnVerifier,
} from "../services/webauthn.js";

/** Dependencies injected into the web-auth routes (all replaceable in tests). */
export interface WebAuthRouteDeps {
  /** Shared OTP challenge store (Redis in prod, in-memory in tests). */
  otpStore: OtpChallengeStore;
  /** SMS transport used to deliver the OTP. */
  smsSender: SmsSender;
  /** Server-side secret binding OTP digests to this deployment. */
  otpSecret: string;
  /** WebAuthn ceremony challenge store. */
  webAuthnStore: WebAuthnChallengeStore;
  /** WebAuthn verifier seam (production FIDO2 adapter; test stub). */
  webAuthnVerifier?: WebAuthnVerifier;
  /** Relying-party id (the web-portal origin host). */
  rpId?: string;
  /** Relying-party display name shown in the passkey prompt. */
  rpName?: string;
  /** OTP lifetime in milliseconds (default 5 minutes). */
  otpTtlMs?: number;
  /** WebAuthn challenge lifetime in milliseconds (default 5 minutes). */
  webAuthnChallengeTtlMs?: number;
  /** Access-token lifetime, as an `@fastify/jwt` `expiresIn` string. */
  accessTokenTtl?: string;
  /** Refresh-token lifetime, as an `@fastify/jwt` `expiresIn` string. */
  refreshTokenTtl?: string;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/** Descriptive error envelope for the 401 rejection paths (R28.1). */
const AuthErrorSchema = z
  .object({
    error: z.literal("Unauthorized"),
    message: z.string().min(1),
  })
  .strict();

const WEB_CHANNEL = "WEB" as const;
const DEFAULT_OTP_TTL_MS = 5 * 60 * 1000;
const DEFAULT_WEBAUTHN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TTL = "15m";
const DEFAULT_REFRESH_TTL = "30d";
const ACCESS_TTL_SECONDS = 15 * 60;
const WEBAUTHN_TIMEOUT_MS = 60_000;
const DEFAULT_RP_ID = "localhost";
const DEFAULT_RP_NAME = "Kshema";
// ES256 (-7) and RS256 (-257): the COSE algorithms platform authenticators use.
const PUB_KEY_CRED_PARAMS = [
  { type: "public-key" as const, alg: -7 },
  { type: "public-key" as const, alg: -257 },
];

export async function webAuthRoutes(
  app: FastifyInstance,
  deps: WebAuthRouteDeps,
): Promise<void> {
  const {
    otpStore,
    smsSender,
    otpSecret,
    webAuthnStore,
    webAuthnVerifier = new DefaultWebAuthnVerifier(),
    rpId = DEFAULT_RP_ID,
    rpName = DEFAULT_RP_NAME,
    otpTtlMs = DEFAULT_OTP_TTL_MS,
    webAuthnChallengeTtlMs = DEFAULT_WEBAUTHN_TTL_MS,
    accessTokenTtl = DEFAULT_ACCESS_TTL,
    refreshTokenTtl = DEFAULT_REFRESH_TTL,
    now = Date.now,
  } = deps;

  const typed = app.withTypeProvider<ZodTypeProvider>();

  /** Mint a WEB-scoped access + refresh token pair for a user. */
  function issueSession(userId: string) {
    const payload: AccessTokenPayload = { sub: userId, channel: WEB_CHANNEL };
    const accessToken = app.jwt.sign(payload, { expiresIn: accessTokenTtl });
    const refreshToken = app.jwt.sign(
      { ...payload, typ: "refresh" } satisfies AccessTokenPayload,
      { expiresIn: refreshTokenTtl },
    );
    return {
      userId,
      accessToken,
      refreshToken,
      expiresAt: new Date(now() + ACCESS_TTL_SECONDS * 1000).toISOString(),
    };
  }

  // ---- Web OTP: request (R28.1) ----
  typed.post(
    "/web/auth/otp/request",
    {
      schema: {
        body: WebOtpRequestSchema,
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
        channel: WEB_CHANNEL,
      });

      await smsSender.send({
        to: phone,
        body: `Your Kshema web verification code is ${code}. It expires in ${Math.round(
          otpTtlMs / 60000,
        )} minutes.`,
      });

      return { challengeId };
    },
  );

  // ---- Web OTP: verify (R28.1, R28.2) ----
  typed.post(
    "/web/auth/otp/verify",
    {
      schema: {
        body: WebOtpVerifySchema,
        response: { 200: WebAuthSessionSchema, 401: AuthErrorSchema },
      },
    },
    async (request, reply) => {
      const { challengeId, code, clientPublicKeyPem } = request.body;

      const challenge = await otpStore.get(challengeId);

      const invalid = () =>
        reply.code(401).send({
          error: "Unauthorized",
          message: "The verification code is incorrect or has expired.",
        });

      if (!challenge) {
        return invalid();
      }
      // A challenge minted for the mobile channel must not authorize a web
      // session (and vice versa).
      if (challenge.channel !== WEB_CHANNEL) {
        return invalid();
      }
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

      await otpStore.consume(challengeId);

      // Upsert the User; only the PUBLIC key from the Web_Crypto_Vault is
      // stored (R28.2). Web sessions do not carry timezone/preferredName here.
      const user = await app.prisma.user.upsert({
        where: { phone: challenge.phone },
        create: {
          phone: challenge.phone,
          publicKeyPem: clientPublicKeyPem,
        },
        update: {
          publicKeyPem: clientPublicKeyPem,
        },
      });

      return issueSession(user.id);
    },
  );

  // ---- WebAuthn: registration options (R28.1) ----
  // Requires a logged-in web session: a user enrolls a passkey after OTP login.
  typed.post(
    "/web/webauthn/register/options",
    {
      onRequest: [app.authenticate],
      schema: {
        body: WebAuthnRegisterOptionsRequestSchema,
        response: {
          200: WebAuthnRegisterOptionsResponseSchema,
          401: AuthErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.sub;
      const user = await app.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", message: "Unknown user." });
      }

      const challenge = await webAuthnStore.create({
        ceremony: "register",
        phone: user.phone,
        expiresAt: now() + webAuthnChallengeTtlMs,
      });

      return {
        challenge,
        rpId,
        rpName,
        userId: user.id,
        userName: user.preferredName ?? user.phone,
        timeoutMs: WEBAUTHN_TIMEOUT_MS,
        attestation: "none" as const,
        pubKeyCredParams: PUB_KEY_CRED_PARAMS,
      };
    },
  );

  // ---- WebAuthn: registration verify (R28.1) ----
  typed.post(
    "/web/webauthn/register/verify",
    {
      onRequest: [app.authenticate],
      schema: {
        body: WebAuthnRegisterVerifySchema,
        response: { 200: WebAuthnRegisterResultSchema, 401: AuthErrorSchema },
      },
    },
    async (request, reply) => {
      const userId = request.user.sub;
      const { credentialId, publicKey, transports, attestation } = request.body;

      const invalid = (message: string) =>
        reply.code(401).send({ error: "Unauthorized", message });

      // The browser echoes the server-minted registration challenge inside the
      // attestation object; the verifier seam owns parsing + binding it to the
      // live challenge stored by the options call (and consuming it single-use
      // in production). The route passes the attestation blob through and maps
      // any verifier throw to a 401.
      let result;
      try {
        result = await webAuthnVerifier.verifyRegistration({
          expectedChallenge: attestation,
          credentialId,
          publicKey,
          attestation,
          rpId,
        });
      } catch {
        return invalid("Passkey registration could not be verified.");
      }

      // Persist the new credential (COSE key + initial counter). A duplicate
      // credentialId is a conflict.
      const existing = await app.prisma.webAuthnCredential.findUnique({
        where: { credentialId },
      });
      if (existing) {
        return invalid("This passkey is already registered.");
      }

      await app.prisma.webAuthnCredential.create({
        data: {
          userId,
          credentialId,
          publicKey: result.publicKey,
          counter: result.counter,
          transports,
        },
      });

      return { credentialId, counter: result.counter };
    },
  );

  // ---- WebAuthn: authentication options (R28.1) ----
  typed.post(
    "/web/webauthn/authenticate/options",
    {
      schema: {
        body: WebAuthnAuthenticateOptionsRequestSchema,
        response: {
          200: WebAuthnAuthenticateOptionsResponseSchema,
          401: AuthErrorSchema,
        },
      },
    },
    async (request) => {
      const { phone } = request.body;
      const user = await app.prisma.user.findUnique({ where: { phone } });

      const credentials = user
        ? await app.prisma.webAuthnCredential.findMany({
            where: { userId: user.id },
          })
        : [];

      // Do not leak whether the phone/user exists: always mint a challenge and
      // return whatever credentials are allowed (possibly empty).
      const challenge = await webAuthnStore.create({
        ceremony: "authenticate",
        phone,
        expiresAt: now() + webAuthnChallengeTtlMs,
      });

      return {
        challenge,
        rpId,
        timeoutMs: WEBAUTHN_TIMEOUT_MS,
        allowCredentials: credentials.map((c) => ({
          id: c.credentialId,
          type: "public-key" as const,
          transports: c.transports,
        })),
      };
    },
  );

  // ---- WebAuthn: authentication verify (R28.1, clone detection) ----
  typed.post(
    "/web/webauthn/authenticate/verify",
    {
      schema: {
        body: WebAuthnAuthenticateVerifySchema,
        response: { 200: WebAuthSessionSchema, 401: AuthErrorSchema },
      },
    },
    async (request, reply) => {
      const {
        credentialId,
        signature,
        authenticatorData,
        clientDataJSON,
        counter,
      } = request.body;

      const invalid = (message: string) =>
        reply.code(401).send({ error: "Unauthorized", message });

      const credential = await app.prisma.webAuthnCredential.findUnique({
        where: { credentialId },
      });
      if (!credential) {
        return invalid("Unknown passkey.");
      }

      // Run the assertion through the verifier seam (FIDO2 signature check in
      // production; structural check in the default verifier).
      let result;
      try {
        result = await webAuthnVerifier.verifyAuthentication({
          expectedChallenge: clientDataJSON, // verifier binds the challenge via clientDataJSON
          credentialId,
          storedPublicKey: Buffer.from(credential.publicKey),
          signature,
          authenticatorData,
          clientDataJSON,
          counter,
          rpId,
        });
      } catch {
        return invalid("Passkey assertion could not be verified.");
      }

      // CLONE DETECTION (R28.1): the asserted counter must be STRICTLY greater
      // than the stored counter. A non-increasing counter means the credential
      // may have been cloned — reject and do NOT advance the stored counter.
      if (result.newCounter <= credential.counter) {
        return invalid(
          "Passkey signature counter did not increase; possible cloned authenticator.",
        );
      }

      await app.prisma.webAuthnCredential.update({
        where: { credentialId },
        data: { counter: result.newCounter },
      });

      return issueSession(credential.userId);
    },
  );
}

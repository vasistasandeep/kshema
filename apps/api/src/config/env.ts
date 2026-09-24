/**
 * apps/api — environment-driven configuration.
 *
 * All runtime knobs (port, JWT secret, Redis URL, CORS origin) come from the
 * environment so the same build runs in dev, test, and the persistent
 * production Fastify deployment. Values are parsed and validated once at
 * startup with Zod so a misconfiguration fails fast with a descriptive error.
 *
 * The Redis connection is intentionally *lazy* (see the events plugin): the
 * app can `buildApp()` and answer `/api/v1/health` without a live Redis or
 * database, which keeps tests hermetic.
 */
import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    /** HTTP port the server binds to. */
    PORT: z.coerce.number().int().min(0).max(65535).default(3001),
    /** Interface to bind. 0.0.0.0 for containers, 127.0.0.1 for local. */
    HOST: z.string().min(1).default("0.0.0.0"),

    /**
     * Secret used to sign/verify JWT bearer access tokens. Required in
     * production; a clearly-labelled insecure fallback is used otherwise so
     * local dev and tests can boot without extra setup.
     */
    JWT_SECRET: z.string().min(1).optional(),

    /**
     * Server-side secret that binds hashed OTP digests to this deployment, so
     * a leak of the challenge store cannot be used to verify codes elsewhere.
     * Required in production; an insecure dev/test fallback keeps local boot
     * frictionless.
     */
    OTP_SECRET: z.string().min(1).optional(),

    /**
     * Origin of the `apps/web` Observer dashboard, permitted by CORS so the
     * browser can open the SSE dashboard stream directly against this
     * persistent Fastify service (never through a serverless route).
     * Comma-separated list is supported for multiple environments.
     */
    WEB_ORIGIN: z.string().min(1).default("http://localhost:3000"),

    /** BullMQ / ioredis connection string for the event producer. */
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

    /** Queue name events are emitted onto (telemetry.received, ghost.received…). */
    EVENTS_QUEUE_NAME: z.string().min(1).default("sentinel-events"),

    /**
     * App secret used to verify inbound WhatsApp (Meta Cloud API) webhook
     * signatures. Meta signs each callback with an `X-Hub-Signature-256`
     * header carrying `sha256=<hex>`, an HMAC-SHA-256 over the RAW request
     * body keyed by this secret. Required in production so a forged callback
     * cannot resolve an incident or poison carrier metrics; an insecure,
     * clearly-labelled dev/test fallback keeps local boot frictionless.
     */
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),

    /**
     * Verify-token echoed back during Meta's GET webhook verification
     * handshake (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`).
     * Optional; when unset the GET handshake is disabled.
     */
    WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),

    /**
     * Shared secret used to verify inbound subscription-provider webhooks
     * (Apple StoreKit App Store Server Notifications JWS, Google Play RTDN, and
     * UPI Autopay recurring-payment callbacks). In this task the real crypto —
     * StoreKit JWS x5c chain validation, Play Pub/Sub message auth, UPI HMAC —
     * lives behind an injectable `SubscriptionWebhookVerifier` seam (see
     * `services/subscriptions.ts`); the default verifier is an HMAC-SHA-256
     * over the raw body keyed by this secret so the pipeline is exercised
     * end-to-end without provider SDKs. Required in production so a forged
     * receipt cannot upgrade a Circle to PRO; an insecure, clearly-labelled
     * dev/test fallback keeps local boot frictionless.
     */
    SUBSCRIPTION_WEBHOOK_SECRET: z.string().min(1).optional(),

    /**
     * PEM-encoded escrowed circle emergency RSA private key used by the
     * ephemeral first-responder portal to break-glass decrypt an
     * Emergency_Medical_Dossier server-side, ONLY within a request serving a
     * valid Emergency_Access_Token for a Stage-4 incident (R33.3, the
     * deliberate break-glass boundary in design "Two Cryptographic
     * Boundaries"). Optional: when unset the responder payload simply omits the
     * dossier (the rest of the triage card still renders). Required in
     * production only if the deployment stores dossiers; there is no insecure
     * fallback because a bogus key would silently fail decryption.
     */
    EMERGENCY_DOSSIER_PRIVATE_KEY: z.string().min(1).optional(),

    /**
     * Base URL the shortened responder-portal link is built from, e.g.
     * `https://k.sh/e`. The minter (task 13.1) appends the token to this base.
     */
    EMERGENCY_PORTAL_BASE_URL: z.string().min(1).default("http://localhost:3000/emergency"),
  })
  .transform((raw) => {
    const isProd = raw.NODE_ENV === "production";
    const jwtSecret =
      raw.JWT_SECRET ??
      (isProd ? undefined : "dev-insecure-jwt-secret-change-me");
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is required when NODE_ENV=production");
    }
    const otpSecret =
      raw.OTP_SECRET ??
      (isProd ? undefined : "dev-insecure-otp-secret-change-me");
    if (!otpSecret) {
      throw new Error("OTP_SECRET is required when NODE_ENV=production");
    }
    const whatsappAppSecret =
      raw.WHATSAPP_APP_SECRET ??
      (isProd ? undefined : "dev-insecure-whatsapp-app-secret-change-me");
    if (!whatsappAppSecret) {
      throw new Error(
        "WHATSAPP_APP_SECRET is required when NODE_ENV=production",
      );
    }
    const subscriptionWebhookSecret =
      raw.SUBSCRIPTION_WEBHOOK_SECRET ??
      (isProd ? undefined : "dev-insecure-subscription-webhook-secret-change-me");
    if (!subscriptionWebhookSecret) {
      throw new Error(
        "SUBSCRIPTION_WEBHOOK_SECRET is required when NODE_ENV=production",
      );
    }
    return {
      ...raw,
      JWT_SECRET: jwtSecret,
      OTP_SECRET: otpSecret,
      WHATSAPP_APP_SECRET: whatsappAppSecret,
      SUBSCRIPTION_WEBHOOK_SECRET: subscriptionWebhookSecret,
      /** CORS allow-list derived from WEB_ORIGIN (comma-separated). */
      webOrigins: raw.WEB_ORIGIN.split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    };
  });

export type AppEnv = z.infer<typeof EnvSchema>;

/**
 * Parse and validate the environment. Throws a descriptive error on a bad
 * configuration. Accepts an override object so tests can inject a config
 * without mutating `process.env`.
 */
export function loadEnv(overrides: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid API environment configuration: ${issues}`);
  }
  return parsed.data;
}

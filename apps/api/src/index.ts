/**
 * apps/api — Fastify v4 API (auth, circles, telemetry, incidents,
 * subscriptions, admin, webhooks).
 *
 * Task 3.1 bootstraps the skeleton: the `buildApp` factory, cross-cutting
 * plugins (Zod validation, JWT bearer auth, Prisma injection, Redis/BullMQ
 * event producer, CORS for the apps/web SSE stream), a graceful-shutdown
 * server entrypoint, and a `/api/v1/health` smoke route. Business routes land
 * in later tasks (3.2 onward).
 */
export const API_APP = "@kshema/api" as const;

export { buildApp, API_PREFIX, type BuildAppOptions } from "./app.js";
export { loadEnv, type AppEnv } from "./config/env.js";
export {
  type EventEmitter,
  type SentinelEvent,
  type SentinelEventName,
} from "./plugins/events.js";
export { type AccessTokenPayload } from "./plugins/auth.js";
export { authRoutes, type AuthRouteDeps } from "./routes/auth.js";
export {
  type SmsSender,
  type SmsMessage,
  ConsoleSmsSender,
} from "./services/sms.js";
export {
  type OtpChallenge,
  type OtpChallengeStore,
  type OtpChannel,
  InMemoryOtpChallengeStore,
  RedisOtpChallengeStore,
} from "./services/otp-store.js";

/**
 * Fastify v4 application factory.
 *
 * `buildApp()` assembles the whole HTTP surface without binding a socket, so
 * it is directly injectable in tests via `app.inject(...)`. It wires:
 *   - the Zod type provider (validation + serialization sourced from
 *     `@kshema/types` schemas across every route);
 *   - `@fastify/cors` permitting the `apps/web` origin for the SSE dashboard
 *     stream (env-driven WEB_ORIGIN);
 *   - the JWT bearer auth plugin (+ `authenticate` guard);
 *   - the Prisma client injection plugin;
 *   - the Redis/BullMQ event producer plugin (lazy connection);
 *   - all routes under the `/api/v1` prefix (health smoke target for now).
 *
 * Business routes (auth/circles/telemetry/…) are added in later tasks.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { loadEnv, type AppEnv } from "./config/env.js";
import authPlugin from "./plugins/auth.js";
import prismaPlugin, { type PrismaPluginOptions } from "./plugins/prisma.js";
import eventsPlugin, { type EventEmitter } from "./plugins/events.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { webAuthRoutes } from "./routes/web-auth.js";
import {
  webDashboardRoutes,
  type WebDashboardRouteDeps,
} from "./routes/web-dashboard.js";
import {
  webVitalityRoutes,
  type WebVitalityRouteDeps,
} from "./routes/web-vitality.js";
import {
  webBillingRoutes,
  type WebBillingRouteDeps,
} from "./routes/web-billing.js";
import { circleRoutes } from "./routes/circles.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { blackboxRoutes } from "./routes/blackbox.js";
import { incidentRoutes } from "./routes/incidents.js";
import {
  vitalityRoutes,
  type VitalityRouteDeps,
} from "./routes/vitality.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { observerRoutes } from "./routes/observer.js";
import { adminRoutes, type AdminRouteDeps } from "./routes/admin.js";
import { InMemoryAdminErrorQueue } from "./services/subscriptions.js";
import {
  emergencyRoutes,
  type EmergencyRouteDeps,
  type DecryptedDossierView,
} from "./routes/emergency.js";
import type { EmergencyTokenClaims } from "./services/emergency-token.js";
// Break-glass boundary (design "Two Cryptographic Boundaries"): the ephemeral
// responder route is the ONE legitimate holder of the escrowed circle emergency
// private key, so it — and only it — imports the dossier decrypt capability.
import { decryptEmergencyDossier } from "@kshema/encryption/decrypt";
import { ConsoleSmsSender, type SmsSender } from "./services/sms.js";
import {
  InMemoryOtpChallengeStore,
  RedisOtpChallengeStore,
  type OtpChallengeStore,
} from "./services/otp-store.js";
import {
  InMemoryInvitationNonceStore,
  RedisInvitationNonceStore,
  type InvitationNonceStore,
} from "./services/invitation-store.js";
import {
  InMemoryWebAuthnChallengeStore,
  RedisWebAuthnChallengeStore,
  type WebAuthnChallengeStore,
  type WebAuthnVerifier,
} from "./services/webauthn.js";
import type {
  SubscriptionWebhookVerifier,
  AdminErrorQueue,
  CheckoutProvider,
} from "./services/subscriptions.js";
import { Redis } from "ioredis";

export const API_PREFIX = "/api/v1" as const;

export interface BuildAppOptions {
  /** Pre-parsed env; defaults to parsing `process.env`. */
  env?: AppEnv;
  /** Inject a Prisma client (tests avoid a live DB). */
  prisma?: PrismaPluginOptions["prisma"];
  /** Inject an event emitter (tests avoid a live Redis). */
  eventEmitter?: EventEmitter;
  /** Inject the OTP challenge store (tests avoid a live Redis). */
  otpStore?: OtpChallengeStore;
  /** Inject the invitation nonce store (tests avoid a live Redis). */
  invitationStore?: InvitationNonceStore;
  /** Inject the WebAuthn ceremony challenge store (tests avoid a live Redis). */
  webAuthnStore?: WebAuthnChallengeStore;
  /** Inject the WebAuthn verifier (tests stub FIDO2 verification). */
  webAuthnVerifier?: WebAuthnVerifier;
  /** Inject the SMS sender (tests capture instead of dispatching). */
  smsSender?: SmsSender;
  /** OTP lifetime override in ms (tests use this to exercise expiry). */
  otpTtlMs?: number;
  /** Clock injection for deterministic OTP expiry in tests. */
  now?: () => number;
  /** Inject the subscription webhook verifier (tests use a stub verifier). */
  subscriptionVerifier?: SubscriptionWebhookVerifier;
  /** Inject the subscription admin error queue (tests capture failures). */
  subscriptionErrorQueue?: AdminErrorQueue;
  /** Inject the checkout provider (tests capture / stub the session). */
  checkoutProvider?: CheckoutProvider;
  /** Inject the micro-voice-note delivery seam (tests capture the reply). */
  voiceNoteDelivery?: VitalityRouteDeps["voiceNoteDelivery"];
  /** Inject the once-per-day morning push guard (tests assert suppression). */
  morningPushGuard?: VitalityRouteDeps["morningPushGuard"];
  /** Inject the Panchanga fallback resolver (tests stub the placeholder). */
  panchangaResolver?: VitalityRouteDeps["panchangaResolver"];
  /** Inject the emergency-token verifier (tests avoid a live JWT plugin). */
  emergencyTokenVerifier?: EmergencyRouteDeps["verifyToken"];
  /** Inject the break-glass dossier decryptor (tests avoid escrow key material). */
  emergencyDossierDecryptor?: EmergencyRouteDeps["decryptDossier"];
  /** Inject the Observer notifier for responder-confirm (tests capture the fan-out). */
  emergencyObserverNotifier?: EmergencyRouteDeps["notifyObservers"];
  /** Inject the admin MFA/RBAC session verifier (tests stub the identity). */
  adminSessionVerifier?: AdminRouteDeps["sessionVerifier"];
  /** Inject the admin on-call alerter seam (tests capture the tripped alert). */
  adminOnCallAlerter?: AdminRouteDeps["onCallAlerter"];
  /** Inject the admin device wakefulness-pinger seam (tests capture the ping). */
  adminWakefulnessPinger?: AdminRouteDeps["wakefulnessPinger"];
  /** Inject the admin purge-scheduler seam (tests capture the scheduled purge). */
  adminPurgeScheduler?: AdminRouteDeps["purgeScheduler"];
  /** Web dashboard SSE cadence override (tests use a bounded finite stream). */
  webDashboardIntervalMs?: WebDashboardRouteDeps["intervalMs"];
  /** Web dashboard SSE max-frames override (tests bound the stream body). */
  webDashboardMaxFrames?: WebDashboardRouteDeps["maxFrames"];
  /** Inject the archived micro-voice-note source (tests seed clips). */
  voiceNoteArchive?: WebVitalityRouteDeps["voiceNoteArchive"];
  /** Inject the hosted billing-portal provider (tests capture the session). */
  billingPortalProvider?: WebBillingRouteDeps["portalProvider"];
  /** Inject the invoice list/PDF store (tests seed invoices). */
  invoiceStore?: WebBillingRouteDeps["invoiceStore"];
  /** Extra Fastify server options (e.g. logger config). */
  loggerEnabled?: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();

  const app = Fastify({
    logger: options.loggerEnabled ?? env.NODE_ENV !== "test",
    // Redis/DB are optional at boot; keep sane defaults for the always-on
    // service that also serves long-lived SSE connections later.
    disableRequestLogging: env.NODE_ENV === "test",
    // The ephemeral first-responder portal carries a signed Emergency_Access_
    // Token as a single URL path segment (`/emergency/:token`, R29.3/R29.4). A
    // JWT easily exceeds Fastify's default 100-char param cap, which would 404
    // a valid token before the route runs, so raise the ceiling generously.
    maxParamLength: 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod as the single source of truth for validation + serialization.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS: permit the apps/web origin(s) so the browser can open the SSE
  // dashboard stream directly against this persistent Fastify service.
  await app.register(cors, {
    origin: env.webOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });

  // Cross-cutting plugins.
  await app.register(authPlugin, { jwtSecret: env.JWT_SECRET });
  await app.register(prismaPlugin, { prisma: options.prisma });
  await app.register(eventsPlugin, {
    redisUrl: env.REDIS_URL,
    queueName: env.EVENTS_QUEUE_NAME,
    emitter: options.eventEmitter,
  });

  // OTP dependencies. Tests inject both; otherwise use a Redis-backed
  // challenge store (with a lazy connection, so boot never needs a live
  // Redis) and the console SMS sender. A real carrier-backed sender replaces
  // the console one in a later telephony task.
  let otpRedis: Redis | undefined;
  const otpStore: OtpChallengeStore =
    options.otpStore ??
    (env.NODE_ENV === "test"
      ? new InMemoryOtpChallengeStore()
      : (() => {
          otpRedis = new Redis(env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
          otpRedis.on("error", () => undefined);
          return new RedisOtpChallengeStore(otpRedis);
        })());
  const smsSender: SmsSender = options.smsSender ?? new ConsoleSmsSender();

  if (otpRedis) {
    app.addHook("onClose", async () => {
      await otpRedis?.quit().catch(() => undefined);
    });
  }

  // Invitation nonce store. Like the OTP store: tests inject an in-memory
  // implementation; production uses a lazily-connected Redis so boot never
  // needs a live Redis. Only single-use nonces are tracked here — never a raw
  // invitation token (see services/invitation-store.ts).
  let invitationRedis: Redis | undefined;
  const invitationStore: InvitationNonceStore =
    options.invitationStore ??
    (env.NODE_ENV === "test"
      ? new InMemoryInvitationNonceStore()
      : (() => {
          invitationRedis = new Redis(env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
          invitationRedis.on("error", () => undefined);
          return new RedisInvitationNonceStore(invitationRedis);
        })());

  if (invitationRedis) {
    app.addHook("onClose", async () => {
      await invitationRedis?.quit().catch(() => undefined);
    });
  }

  // WebAuthn ceremony challenge store (task 20.1, R28.1). Same lifecycle model
  // as the OTP/invitation stores: tests inject an in-memory implementation;
  // production uses a lazily-connected Redis so boot never needs a live Redis.
  // Only short-lived, single-use attestation/assertion challenges live here —
  // never a private key or a persisted credential (which lives in Prisma).
  let webAuthnRedis: Redis | undefined;
  const webAuthnStore: WebAuthnChallengeStore =
    options.webAuthnStore ??
    (env.NODE_ENV === "test"
      ? new InMemoryWebAuthnChallengeStore()
      : (() => {
          webAuthnRedis = new Redis(env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
          webAuthnRedis.on("error", () => undefined);
          return new RedisWebAuthnChallengeStore(webAuthnRedis);
        })());

  if (webAuthnRedis) {
    app.addHook("onClose", async () => {
      await webAuthnRedis?.quit().catch(() => undefined);
    });
  }

  // The WebAuthn relying-party id is the registrable host of the web-portal
  // origin (a passkey is bound to this domain). Derive it from the first CORS
  // origin; fall back to "localhost" for dev/test if the URL is unparseable.
  const webAuthnRpId = (() => {
    const first = env.webOrigins[0];
    if (!first) {
      return "localhost";
    }
    try {
      return new URL(first).hostname;
    } catch {
      return "localhost";
    }
  })();

  // Emergency responder-portal seams (task 13.3, R29/R33). Tests inject their
  // own; production wires the escrowed circle emergency key (when configured)
  // and an event-backed Observer notifier.
  //
  // Break-glass dossier decryptor: present ONLY when an escrowed private key is
  // configured. The route invokes it solely within a valid-token, Stage-4
  // request (R33.3). When unset the responder payload omits the dossier.
  const emergencyDossierDecryptor: EmergencyRouteDeps["decryptDossier"] =
    options.emergencyDossierDecryptor ??
    (env.EMERGENCY_DOSSIER_PRIVATE_KEY
      ? (envelope) =>
          decryptEmergencyDossier<DecryptedDossierView>(
            envelope,
            env.EMERGENCY_DOSSIER_PRIVATE_KEY as string,
          )
      : undefined);

  // Observer notifier (R29.9). The confirm route already emits
  // `incident.resolved`, which the Sentinel worker (task 10.3) consumes to
  // perform the atomic transition AND fan a "resident confirmed safe" alert out
  // to every Circle Observer — so the default notifier is a no-op placeholder
  // that keeps the responder-confirm flow self-contained without double-emitting
  // the resolution event. Tests inject a capturing notifier to assert the
  // fan-out is invoked; a dedicated push/SSE channel can replace this seam
  // without touching the route.
  const defaultObserverNotifier: NonNullable<
    EmergencyRouteDeps["notifyObservers"]
  > = async () => {
    /* Observer fan-out is driven by the worker consuming `incident.resolved`. */
  };

  // Shared subscription/admin webhook error queue (R21.20). The subscription
  // webhook route WRITES failed receipts here and the admin error-queue route
  // READS them, so a failed payment surfaces in the admin console. Tests may
  // inject their own via `subscriptionErrorQueue`; otherwise a single in-memory
  // queue instance is shared by both routes.
  const sharedErrorQueue: AdminErrorQueue =
    options.subscriptionErrorQueue ?? new InMemoryAdminErrorQueue();

  // Routes, all under /api/v1. Business routes join in later tasks.
  await app.register(
    async (v1) => {
      await v1.register(healthRoutes);
      await v1.register(authRoutes, {
        otpStore,
        smsSender,
        otpSecret: env.OTP_SECRET,
        ...(options.otpTtlMs !== undefined ? { otpTtlMs: options.otpTtlMs } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // Web portal auth (task 20.1, R28.1/R28.2): OTP over the WEB login
      // channel + optional WebAuthn passkeys. Shares the OTP challenge store
      // and SMS sender with the mobile auth routes; the RP id is derived from
      // the configured web origin host. The WebAuthn verifier defaults to the
      // SDK-free structural verifier; a production FIDO2 adapter is injectable.
      await v1.register(webAuthRoutes, {
        otpStore,
        smsSender,
        otpSecret: env.OTP_SECRET,
        webAuthnStore,
        ...(options.webAuthnVerifier !== undefined
          ? { webAuthnVerifier: options.webAuthnVerifier }
          : {}),
        rpId: webAuthnRpId,
        ...(options.otpTtlMs !== undefined ? { otpTtlMs: options.otpTtlMs } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // Web Observer dashboard stream (task 20.2, R28.5/R28.8/R28.9): SSE on
      // this persistent Fastify service pushing per-Anchor well-being + the
      // dual-timezone tick, plus the WebSocket-fallback snapshot endpoint. Auth
      // is via bearer header OR `?token=` (for browser EventSource). Tests bound
      // the stream with a finite `maxFrames`.
      await v1.register(webDashboardRoutes, {
        ...(options.webDashboardIntervalMs !== undefined
          ? { intervalMs: options.webDashboardIntervalMs }
          : {}),
        ...(options.webDashboardMaxFrames !== undefined
          ? { maxFrames: options.webDashboardMaxFrames }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // Web Observer vitality history (task 20.2, R28.13/R28.14/R28.15): the
      // 30-day connection-rhythm calendar and archived ≤10s voice replies +
      // Vitality_Pulse cards — carrying no location breadcrumb. The audio
      // archive is a seam (empty until the storage task); tests inject clips.
      await v1.register(webVitalityRoutes, {
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.voiceNoteArchive !== undefined
          ? { voiceNoteArchive: options.voiceNoteArchive }
          : {}),
      });
      // Web self-service billing (task 20.2, R28.16/R28.17): portal session,
      // tier + trial-countdown summary, monthly/annual interval switch, and
      // tax-compliant invoice list + PDF download. Provider + invoice store are
      // seams (Stripe/Razorpay); tests inject fakes.
      await v1.register(webBillingRoutes, {
        ...(options.billingPortalProvider !== undefined
          ? { portalProvider: options.billingPortalProvider }
          : {}),
        ...(options.invoiceStore !== undefined
          ? { invoiceStore: options.invoiceStore }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      await v1.register(circleRoutes, {
        invitationStore,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      await v1.register(telemetryRoutes);
      await v1.register(blackboxRoutes);
      await v1.register(incidentRoutes, {
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // Mobile Observer dashboard — calm per-Anchor derived well-being state
      // (task 21.1, R15). Read-only and authenticated; carries no continuous
      // location trace.
      await v1.register(observerRoutes);
      // Ephemeral first-responder emergency portal (task 13.3, R29/R33). Zero-
      // login, token-gated. The token verifier defaults to the JWT plugin's
      // `verify`; the break-glass dossier decryptor is wired from the escrowed
      // circle emergency key when configured; the Observer notifier fans out on
      // responder-confirm. Tests inject all three.
      await v1.register(emergencyRoutes, {
        verifyToken:
          options.emergencyTokenVerifier ??
          ((rawToken) =>
            app.jwt.verify<EmergencyTokenClaims>(rawToken)),
        ...(emergencyDossierDecryptor !== undefined
          ? { decryptDossier: emergencyDossierDecryptor }
          : {}),
        notifyObservers:
          options.emergencyObserverNotifier ?? defaultObserverNotifier,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // Family Vitality engine — Sparsh, connection rhythm, micro-voice-note,
      // and the Daily Panchanga card (task 14.4, R7.4/R22). Seams (voice-note
      // delivery, once-per-day morning push guard, Panchanga resolver) default
      // in-process; tests inject fakes.
      await v1.register(vitalityRoutes, {
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.voiceNoteDelivery !== undefined
          ? { voiceNoteDelivery: options.voiceNoteDelivery }
          : {}),
        ...(options.morningPushGuard !== undefined
          ? { morningPushGuard: options.morningPushGuard }
          : {}),
        ...(options.panchangaResolver !== undefined
          ? { panchangaResolver: options.panchangaResolver }
          : {}),
      });
      // Webhook routes live in their OWN encapsulated scope (a nested
      // register) so their raw-body-retaining JSON content-type parser is
      // isolated from the global JSON parsing used by every other route.
      await v1.register(webhookRoutes, {
        appSecret: env.WHATSAPP_APP_SECRET,
        ...(env.WHATSAPP_VERIFY_TOKEN !== undefined
          ? { verifyToken: env.WHATSAPP_VERIFY_TOKEN }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // Subscription checkout + provider webhooks + tier transitions. Wrapped
      // in its own encapsulated register so the webhook raw-body JSON parser it
      // installs internally never leaks into the sibling routes above.
      await v1.register(
        async (sub) => {
          await sub.register(subscriptionRoutes, {
            webhookSecret: env.SUBSCRIPTION_WEBHOOK_SECRET,
            ...(options.subscriptionVerifier !== undefined
              ? { verifier: options.subscriptionVerifier }
              : {}),
            // Share the one error-queue instance with the admin route (R21.20).
            errorQueue: sharedErrorQueue,
            ...(options.checkoutProvider !== undefined
              ? { checkoutProvider: options.checkoutProvider }
              : {}),
            ...(options.now !== undefined ? { now: options.now } : {}),
          });
        },
      );
      // Admin console API (task 19.1, R21). Guarded by AdminAuthGuard (MFA +
      // single-role RBAC); every handler writes an append-only AdminAuditLog
      // row. Reads the SAME shared error queue the subscription webhook writes
      // to (R21.20). Seams (session verifier, on-call alerter, wakefulness
      // pinger, purge scheduler) default in-process; tests inject fakes.
      await v1.register(adminRoutes, {
        errorQueue: sharedErrorQueue,
        ...(options.adminSessionVerifier !== undefined
          ? { sessionVerifier: options.adminSessionVerifier }
          : {}),
        ...(options.adminOnCallAlerter !== undefined
          ? { onCallAlerter: options.adminOnCallAlerter }
          : {}),
        ...(options.adminWakefulnessPinger !== undefined
          ? { wakefulnessPinger: options.adminWakefulnessPinger }
          : {}),
        ...(options.adminPurgeScheduler !== undefined
          ? { purgeScheduler: options.adminPurgeScheduler }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}

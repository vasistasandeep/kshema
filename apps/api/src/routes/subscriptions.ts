/**
 * Subscription checkout + provider webhooks + tier transitions (task 15.1 —
 * R20.1, R20.4, R20.8, R20.9, R20.10).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `POST /api/v1/subscriptions/checkout`          authenticated; begin purchase
 *   - `POST /api/v1/subscriptions/webhooks/apple`    StoreKit JWS validation
 *   - `POST /api/v1/subscriptions/webhooks/google`   Play RTDN validation
 *   - `POST /api/v1/subscriptions/webhooks/upi`      UPI Autopay validation
 *
 * ---------------------------------------------------------------------------
 * CHECKOUT (R20.1 lifecycle, R20.10 providers). `POST /subscriptions/checkout`
 * is authenticated: it initiates a purchase for the CALLER'S circle (derived
 * from the caller's most recent CircleMember) and returns a checkout session
 * URL. The actual payment happens off-platform; provider integration is behind
 * the injectable `CheckoutProvider` seam, so the route never embeds StoreKit /
 * Play Billing / UPI SDK specifics.
 *
 * ---------------------------------------------------------------------------
 * WEBHOOKS (R20.8, R20.10, R21.20). The three webhook routes are registered in
 * their OWN encapsulated Fastify scope with a raw-body-retaining JSON content
 * parser (same pattern as the WhatsApp webhook) so signature verification runs
 * over the EXACT request bytes. Signature/receipt validation is behind the
 * injectable `SubscriptionWebhookVerifier` seam (Apple StoreKit JWS, Google
 * Play RTDN, UPI Autopay). On a VALID + active receipt the route drives the
 * Subscription to PRO via the pure `transitionTier` guard (TRIAL->PRO or
 * SHIELD_PAUSED->PRO), sets `proSince`/`externalRef`/`interval`, and emits
 * `subscription.changed` so the worker RESUMES that Circle's routines (R20.8).
 * On a verification/processing failure the raw payload is routed to the
 * injectable `AdminErrorQueue` (R21.20) and the route replies 4xx; no tier
 * change and no resume event occur.
 *
 * ---------------------------------------------------------------------------
 * TIER TRANSITIONS. The guarded state machine (`transitionTier`) lives in
 * `services/subscriptions.ts` as a PURE function so the worker (task 15.2) and
 * the property test (task 15.3) reuse it. This route additionally exposes
 * `applyTrialExpiry` on `app` (SHIELD_PAUSED on trial expiry, R20.4) for the
 * worker/cron to invoke; the scheduling of that call is the worker's concern.
 * `subscription.changed` is emitted on every persisted tier change so the
 * worker suspends (SHIELD_PAUSED) or resumes (PRO/TRIAL) accordingly.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CheckoutSchema, CheckoutResponseSchema } from "@kshema/types";
import {
  transitionTier,
  applyTrialExpiry as applyTrialExpiryHelper,
  HmacSubscriptionWebhookVerifier,
  InMemoryAdminErrorQueue,
  MockCheckoutProvider,
  type SubscriptionProvider,
  type SubscriptionWebhookVerifier,
  type AdminErrorQueue,
  type CheckoutProvider,
} from "../services/subscriptions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Raw request bytes retained by the subscription-webhook JSON parser. */
    rawBody?: Buffer;
  }
}

/** Circle roles that make a member an authorized checkout initiator. */
const CHECKOUT_ROLES = new Set(["ANCHOR", "OBSERVER", "MUTUAL"]);

/** Descriptive error envelopes (mirroring the incident routes). */
const BadRequestSchema = z
  .object({ error: z.literal("Bad Request"), message: z.string().min(1) })
  .strict();
const ForbiddenSchema = z
  .object({ error: z.literal("Forbidden"), message: z.string().min(1) })
  .strict();
const UnauthorizedSchema = z
  .object({ error: z.literal("Unauthorized"), message: z.string().min(1) })
  .strict();

/** Webhook acknowledgement body. */
const WebhookAckSchema = z
  .object({
    provider: z.enum(["apple", "google", "upi"]),
    processed: z.boolean(),
  })
  .strict();

export interface SubscriptionRouteDeps {
  /** Shared secret backing the default HMAC verifier (env-driven). */
  webhookSecret: string;
  /** Inject a verifier (tests use a stub; prod swaps in real provider crypto). */
  verifier?: SubscriptionWebhookVerifier;
  /** Inject the admin error queue (R21.20 seam). */
  errorQueue?: AdminErrorQueue;
  /** Inject the checkout provider seam. */
  checkoutProvider?: CheckoutProvider;
  /** Clock injection for deterministic `proSince` in tests. */
  now?: () => number;
}

export async function subscriptionRoutes(
  app: FastifyInstance,
  deps: SubscriptionRouteDeps,
): Promise<void> {
  const {
    webhookSecret,
    verifier = new HmacSubscriptionWebhookVerifier(webhookSecret),
    errorQueue = new InMemoryAdminErrorQueue(),
    checkoutProvider = new MockCheckoutProvider(),
    now = Date.now,
  } = deps;

  const typed = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // POST /subscriptions/checkout — authenticated; begin an off-platform
  // purchase for the caller's circle and return the checkout session URL.
  // -------------------------------------------------------------------------
  typed.post(
    "/subscriptions/checkout",
    {
      onRequest: [app.authenticate],
      schema: {
        body: CheckoutSchema,
        response: {
          200: CheckoutResponseSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const callerId = request.user.sub;
      const { interval } = request.body;

      // Derive the caller's circle. Any member (Anchor/Observer/Mutual) may
      // begin a purchase for their circle's shield.
      const membership = await app.prisma.circleMember.findFirst({
        where: { userId: callerId, role: { in: ["ANCHOR", "OBSERVER", "MUTUAL"] } },
        select: { circleId: true, role: true },
      });
      if (!membership || !CHECKOUT_ROLES.has(membership.role)) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only a Circle member may begin a subscription checkout.",
        });
      }

      const session = await checkoutProvider.createSession({
        circleId: membership.circleId,
        interval,
      });

      return { checkoutUrl: session.checkoutUrl };
    },
  );

  // -------------------------------------------------------------------------
  // Webhook sub-scope: encapsulated raw-body JSON parser so HMAC/JWS
  // verification runs over the EXACT bytes, isolated from global JSON parsing.
  // -------------------------------------------------------------------------
  await app.register(async (hooks) => {
    hooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (request, body, done) => {
        const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
        request.rawBody = raw;
        if (raw.length === 0) {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(raw.toString("utf8")) as unknown);
        } catch (err) {
          (err as Error & { statusCode?: number }).statusCode = 400;
          done(err as Error, undefined);
        }
      },
    );

    const hooksTyped = hooks.withTypeProvider<ZodTypeProvider>();

    /**
     * Shared handler for all three providers. Verifies the raw body via the
     * seam; on a valid + active receipt drives the tier to PRO through the pure
     * guard and emits `subscription.changed`; on any failure routes the raw
     * payload to the admin error queue (R21.20) and replies 4xx.
     */
    const handleWebhook = async (
      provider: SubscriptionProvider,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const raw = request.rawBody ?? Buffer.alloc(0);
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      }

      const routeToErrorQueue = async (reason: string) => {
        await errorQueue.push({
          provider,
          rawBodyBase64: raw.toString("base64"),
          reason,
          at: new Date(now()).toISOString(),
        });
      };

      const receipt = verifier.verify(provider, raw, headers);

      // 1. Signature/receipt invalid -> admin error queue, reject.
      if (!receipt.valid) {
        await routeToErrorQueue(
          receipt.reason ?? "Signature verification failed.",
        );
        return reply.code(401).send({
          error: "Unauthorized" as const,
          message: "Invalid subscription webhook signature.",
        });
      }

      // 2. Valid signature but not an active/successful payment, or missing the
      //    circle reference we need to apply it -> processing failure -> queue.
      if (!receipt.active || !receipt.circleId) {
        await routeToErrorQueue(
          receipt.reason ??
            (!receipt.circleId
              ? "Receipt is missing a circle reference."
              : "Receipt does not represent an active subscription."),
        );
        return reply.code(400).send({
          error: "Bad Request" as const,
          message: "Subscription webhook could not be processed.",
        });
      }

      // 3. Load the Subscription for the circle and apply the guarded PRO
      //    transition. An unknown subscription or an illegal transition (e.g.
      //    already PRO) is a processing failure -> queue.
      const subscription = await app.prisma.subscription.findUnique({
        where: { circleId: receipt.circleId },
        select: { id: true, tier: true },
      });
      if (!subscription) {
        await routeToErrorQueue(
          `No subscription for circle ${receipt.circleId}.`,
        );
        return reply.code(400).send({
          error: "Bad Request" as const,
          message: "Subscription webhook could not be processed.",
        });
      }

      const transition = transitionTier(subscription.tier, "PRO_PURCHASE");
      if (!transition.ok) {
        await routeToErrorQueue(transition.reason);
        return reply.code(400).send({
          error: "Bad Request" as const,
          message: "Subscription webhook could not be processed.",
        });
      }

      // Persist PRO: set tier, proSince, externalRef, and interval when known.
      await app.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          tier: transition.to,
          proSince: new Date(now()),
          ...(receipt.externalRef !== undefined
            ? { externalRef: receipt.externalRef }
            : {}),
          ...(receipt.interval !== undefined
            ? { interval: receipt.interval }
            : {}),
        },
      });

      // Emit for the worker to RESUME this Circle's routines (R20.8).
      await app.events.emit("subscription.changed", {
        circleId: receipt.circleId,
        from: transition.from,
        to: transition.to,
        event: "PRO_PURCHASE" as const,
        provider,
      });

      return reply.code(200).send({ provider, processed: true });
    };

    const webhookSchema = {
      response: {
        200: WebhookAckSchema,
        400: BadRequestSchema,
        401: UnauthorizedSchema,
      },
    };

    hooksTyped.post(
      "/subscriptions/webhooks/apple",
      { schema: webhookSchema },
      (request, reply) => handleWebhook("apple", request, reply),
    );
    hooksTyped.post(
      "/subscriptions/webhooks/google",
      { schema: webhookSchema },
      (request, reply) => handleWebhook("google", request, reply),
    );
    hooksTyped.post(
      "/subscriptions/webhooks/upi",
      { schema: webhookSchema },
      (request, reply) => handleWebhook("upi", request, reply),
    );
  });

  // -------------------------------------------------------------------------
  // Trial-expiry transition (R20.4). The worker/cron drives TRIAL->SHIELD_PAUSED
  // by importing `applyTrialExpiry` from `services/subscriptions.ts` directly
  // (scheduling is the worker's concern). We also expose a bound convenience on
  // `app` so an in-process caller can invoke it without re-wiring prisma/events.
  // Guarded with `hasDecorator` so re-registration is safe.
  // -------------------------------------------------------------------------
  if (!app.hasDecorator("applyTrialExpiry")) {
    app.decorate("applyTrialExpiry", (circleId: string) =>
      applyTrialExpiryHelper(app.prisma, app.events, circleId),
    );
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Transition a Circle's Subscription TRIAL->SHIELD_PAUSED on trial expiry
     * (R20.4) and emit `subscription.changed`. Convenience binding over the
     * shared `applyTrialExpiry` helper; the worker/cron may import that helper
     * directly instead. Scheduling is the worker's concern.
     */
    applyTrialExpiry?: (
      circleId: string,
    ) => Promise<{ applied: boolean; reason?: string }>;
  }
}

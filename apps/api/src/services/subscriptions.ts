/**
 * Subscription lifecycle service (task 15.1 — R20.1, R20.4, R20.8, R20.9,
 * R20.10).
 *
 * This module holds the *pure* and *seam* pieces of the subscription
 * lifecycle so both the API route (`routes/subscriptions.ts`) and the Sentinel
 * worker (task 15.2, tier gate) can reuse the same logic without cross-package
 * churn:
 *
 *   1. `transitionTier` — the guarded, PURE tier state machine. It enforces the
 *      only legal transitions and rejects everything else. It performs NO I/O,
 *      so it is trivially unit- and property-testable and safe for the worker
 *      to import.
 *
 *   2. `SubscriptionWebhookVerifier` — the injectable signature-verification
 *      SEAM for the three providers (Apple StoreKit App Store Server
 *      Notifications v2 JWS, Google Play Real-Time Developer Notifications, and
 *      UPI Autopay recurring-payment callbacks). The route depends only on this
 *      interface; a `HmacSubscriptionWebhookVerifier` (shared-secret HMAC over
 *      the raw body) is the default dev/test implementation, and the real
 *      crypto (StoreKit x5c JWS chain, Play Pub/Sub JWT, UPI HMAC/mandate) is a
 *      documented stub to be filled in a later integration task.
 *
 *   3. `AdminErrorQueue` — the injectable SEAM a failed webhook lands in
 *      (R21.20). There is no dedicated Prisma table for this yet, so the
 *      default implementation is an in-memory queue; a persisted marker /
 *      dedicated model is a follow-up. Modelling it as a seam lets the Admin
 *      console (task 19.1) swap in a durable, inspect/edit/re-drive-able store
 *      without touching this route.
 *
 *   4. `TrialReminderScheduler` + `computeDueTrialReminder` — the reminder
 *      emission SEAM plus the PURE "is a reminder due?" decision. The 4-day and
 *      1-day trial reminders (R20.9) are delivered by the worker/cron; the pure
 *      function decides *which* reminder (if any) is due for a given
 *      `trialEndsAt` at a given `now`, and the seam performs the actual
 *      per-Observer delivery.
 *
 *   5. `CheckoutProvider` — the injectable SEAM `POST /subscriptions/checkout`
 *      uses to begin an off-platform purchase and hand back a checkout
 *      session/URL. The default `MockCheckoutProvider` returns a deterministic
 *      dev URL; the live adapter (StoreKit / Play Billing / UPI Autopay
 *      mandate creation) slots in behind the same interface.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingInterval, SubscriptionTier } from "@kshema/types";

// ---------------------------------------------------------------------------
// 1. Pure guarded tier state machine (R20.1, R20.4, R20.8; Admin R21.19 reuses
//    SHIELD_PAUSED -> TRIAL). Shared with the worker.
// ---------------------------------------------------------------------------

/** The lifecycle events that can drive a tier change. */
export type SubscriptionEvent =
  /** A verified successful payment -> PRO (R20.8). Valid from TRIAL or SHIELD_PAUSED. */
  | "PRO_PURCHASE"
  /** The trial window elapsed with no active paid sub -> SHIELD_PAUSED (R20.4). */
  | "TRIAL_EXPIRY"
  /** Admin/BILLING_OPS restores a lapsed Circle SHIELD_PAUSED -> TRIAL (R21.19). */
  | "TRIAL_EXTENSION";

/**
 * The ONLY legal tier transitions (design Property 10):
 *   TRIAL          -> PRO            (PRO_PURCHASE)
 *   TRIAL          -> SHIELD_PAUSED  (TRIAL_EXPIRY)
 *   SHIELD_PAUSED  -> PRO            (PRO_PURCHASE)
 *   SHIELD_PAUSED  -> TRIAL          (TRIAL_EXTENSION)
 *
 * Anything else — including any transition *out of* PRO, a TRIAL_EXPIRY while
 * PRO, or a self-loop — is rejected. Idempotent no-ops (e.g. PRO_PURCHASE while
 * already PRO) are also rejected so callers must treat a re-delivered webhook
 * explicitly rather than silently succeeding on an illegal edge.
 */
const TRANSITIONS: ReadonlyArray<{
  from: SubscriptionTier;
  event: SubscriptionEvent;
  to: SubscriptionTier;
}> = [
  { from: "TRIAL", event: "PRO_PURCHASE", to: "PRO" },
  { from: "TRIAL", event: "TRIAL_EXPIRY", to: "SHIELD_PAUSED" },
  { from: "SHIELD_PAUSED", event: "PRO_PURCHASE", to: "PRO" },
  { from: "SHIELD_PAUSED", event: "TRIAL_EXTENSION", to: "TRIAL" },
];

export interface TransitionOk {
  ok: true;
  from: SubscriptionTier;
  to: SubscriptionTier;
  event: SubscriptionEvent;
}

export interface TransitionErr {
  ok: false;
  from: SubscriptionTier;
  event: SubscriptionEvent;
  reason: string;
}

export type TransitionResult = TransitionOk | TransitionErr;

/**
 * Pure guarded transition. Returns the target tier on a legal edge or a
 * descriptive rejection on an illegal one. No I/O — safe to import from the
 * worker (task 15.2) and to exercise in the property test (task 15.3).
 */
export function transitionTier(
  from: SubscriptionTier,
  event: SubscriptionEvent,
): TransitionResult {
  const edge = TRANSITIONS.find((t) => t.from === from && t.event === event);
  if (!edge) {
    return {
      ok: false,
      from,
      event,
      reason: `Illegal subscription transition: no ${event} edge from ${from}.`,
    };
  }
  return { ok: true, from, to: edge.to, event };
}

/** True iff `event` is legal from `from` (thin wrapper over `transitionTier`). */
export function canTransition(
  from: SubscriptionTier,
  event: SubscriptionEvent,
): boolean {
  return transitionTier(from, event).ok;
}

// ---------------------------------------------------------------------------
// Trial-expiry transition (R20.4). A shared helper the worker/cron invokes to
// move a Circle TRIAL -> SHIELD_PAUSED on trial expiry, emitting
// `subscription.changed` so the worker suspends the Circle's routines (task
// 15.2). It is exported here (rather than only decorated on the Fastify
// instance) so the worker can import it directly without the API surface. The
// scheduling of *when* to call it is the worker's concern.
// ---------------------------------------------------------------------------

/** The subset of Prisma the trial-expiry helper needs (loose to stay testable). */
export interface SubscriptionStore {
  subscription: {
    findUnique(args: {
      where: { circleId: string };
      select?: Record<string, boolean>;
    }): Promise<{ id: string; tier: SubscriptionTier } | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/** The subset of the event emitter the helper needs. */
export interface SubscriptionEventEmitter {
  emit(name: "subscription.changed", payload: unknown): Promise<void>;
}

export interface ApplyTrialExpiryResult {
  applied: boolean;
  reason?: string;
}

/**
 * Move a Circle's Subscription TRIAL -> SHIELD_PAUSED on trial expiry (R20.4)
 * through the pure guard, persisting the tier and emitting
 * `subscription.changed`. Rejects (without mutation/emit) when there is no
 * subscription for the circle or the transition is illegal (e.g. already PRO).
 */
export async function applyTrialExpiry(
  store: SubscriptionStore,
  emitter: SubscriptionEventEmitter,
  circleId: string,
): Promise<ApplyTrialExpiryResult> {
  const subscription = await store.subscription.findUnique({
    where: { circleId },
    select: { id: true, tier: true },
  });
  if (!subscription) {
    return { applied: false, reason: `No subscription for circle ${circleId}.` };
  }
  const transition = transitionTier(subscription.tier, "TRIAL_EXPIRY");
  if (!transition.ok) {
    return { applied: false, reason: transition.reason };
  }
  await store.subscription.update({
    where: { id: subscription.id },
    data: { tier: transition.to },
  });
  await emitter.emit("subscription.changed", {
    circleId,
    from: transition.from,
    to: transition.to,
    event: "TRIAL_EXPIRY",
  });
  return { applied: true };
}

// ---------------------------------------------------------------------------
// Trial-extension transition (R21.19). The Admin console (BILLING_OPS /
// SUPER_ADMIN) grants a trial extension to a lapsed Circle: the tier is
// restored SHIELD_PAUSED -> TRIAL through the same pure guard, the trial
// expiry is pushed out by `additionalDays`, and `subscription.changed` is
// emitted so the worker RESUMES that Circle's routines. A Circle still on
// TRIAL is extended in place (expiry pushed out, tier unchanged); a PRO Circle
// needs no extension and is rejected.
// ---------------------------------------------------------------------------

/** The subset of Prisma the trial-extension helper needs. */
export interface TrialExtensionStore {
  subscription: {
    findUnique(args: {
      where: { circleId: string };
      select?: Record<string, boolean>;
    }): Promise<{
      id: string;
      tier: SubscriptionTier;
      trialEndsAt: Date;
    } | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export interface ApplyTrialExtensionResult {
  applied: boolean;
  reason?: string;
  previousTier?: SubscriptionTier;
  tier?: SubscriptionTier;
  trialEndsAt?: Date;
}

/** One day in milliseconds (trial-extension arithmetic). */
const TRIAL_EXTENSION_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grant a trial extension to a Circle (R21.19). Restores SHIELD_PAUSED -> TRIAL
 * via the pure guard, extends `trialEndsAt` by `additionalDays` (measured from
 * whichever is later — the current expiry or `now`, so a long-lapsed Circle
 * still gets a full window), persists the new tier + expiry, and emits
 * `subscription.changed`. A Circle already on TRIAL is extended in place
 * (expiry pushed out, tier unchanged); a PRO Circle is rejected (no extension
 * needed); an unknown Circle is rejected.
 */
export async function applyTrialExtension(
  store: TrialExtensionStore,
  emitter: SubscriptionEventEmitter,
  circleId: string,
  additionalDays: number,
  now: Date = new Date(),
): Promise<ApplyTrialExtensionResult> {
  const subscription = await store.subscription.findUnique({
    where: { circleId },
    select: { id: true, tier: true, trialEndsAt: true },
  });
  if (!subscription) {
    return { applied: false, reason: `No subscription for circle ${circleId}.` };
  }

  // Resolve the target tier. From SHIELD_PAUSED the guard restores TRIAL;
  // from TRIAL we stay on TRIAL (extend in place). PRO is rejected.
  let targetTier: SubscriptionTier;
  if (subscription.tier === "SHIELD_PAUSED") {
    const transition = transitionTier("SHIELD_PAUSED", "TRIAL_EXTENSION");
    if (!transition.ok) {
      return { applied: false, reason: transition.reason };
    }
    targetTier = transition.to;
  } else if (subscription.tier === "TRIAL") {
    targetTier = "TRIAL";
  } else {
    return {
      applied: false,
      reason: `A ${subscription.tier} subscription cannot be granted a trial extension.`,
    };
  }

  const base = Math.max(subscription.trialEndsAt.getTime(), now.getTime());
  const newTrialEndsAt = new Date(base + additionalDays * TRIAL_EXTENSION_DAY_MS);

  await store.subscription.update({
    where: { id: subscription.id },
    data: { tier: targetTier, trialEndsAt: newTrialEndsAt },
  });

  await emitter.emit("subscription.changed", {
    circleId,
    from: subscription.tier,
    to: targetTier,
    event: "TRIAL_EXTENSION",
  });

  return {
    applied: true,
    previousTier: subscription.tier,
    tier: targetTier,
    trialEndsAt: newTrialEndsAt,
  };
}

// ---------------------------------------------------------------------------
// 2. Webhook signature-verification seam (R20.10).
// ---------------------------------------------------------------------------

/** The three subscription providers this task validates receipts for (R20.10). */
export type SubscriptionProvider = "apple" | "google" | "upi";

/** Result of verifying + parsing a provider webhook payload. */
export interface VerifiedReceipt {
  /** Whether the signature/receipt validated. */
  valid: boolean;
  /** The provider's opaque subscription reference (stored on `externalRef`). */
  externalRef?: string;
  /** Whether the receipt represents a *successful, active* paid subscription. */
  active?: boolean;
  /** Billing cadence encoded in the receipt, when present. */
  interval?: BillingInterval;
  /** The Circle the receipt applies to (provider payload carries our app ref). */
  circleId?: string;
  /** Human-readable reason a receipt was rejected (for the error queue). */
  reason?: string;
}

/**
 * Signature-verification seam. Each method validates the RAW request bytes for
 * one provider and returns a normalised `VerifiedReceipt`. The route depends on
 * this interface only, so the real crypto can land later without route churn.
 */
export interface SubscriptionWebhookVerifier {
  verify(
    provider: SubscriptionProvider,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): VerifiedReceipt;
}

/**
 * Default dev/test verifier: an HMAC-SHA-256 over the raw body keyed by the
 * shared `SUBSCRIPTION_WEBHOOK_SECRET`, supplied in an `x-kshema-signature`
 * header as `sha256=<hex>` (mirrors the WhatsApp webhook convention). The
 * body is expected to be JSON of shape
 * `{ circleId, externalRef, active, interval? }`.
 *
 * Real provider verification is a DOCUMENTED STUB — replace `verify` per
 * provider with:
 *   - apple:  decode the App Store Server Notification v2 signed JWS, validate
 *             the `x5c` certificate chain to Apple's root, and read the
 *             `notificationType`/`transactionInfo`;
 *   - google: authenticate the Play RTDN Pub/Sub push (JWT `Authorization`),
 *             then look up the purchase token via the Play Developer API;
 *   - upi:    verify the Autopay recurring-mandate callback HMAC and mandate
 *             status per the PSP contract.
 * All three normalise into the same `VerifiedReceipt`, so this route is stable.
 */
export class HmacSubscriptionWebhookVerifier
  implements SubscriptionWebhookVerifier
{
  constructor(private readonly secret: string) {}

  verify(
    _provider: SubscriptionProvider,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): VerifiedReceipt {
    const header = headers["x-kshema-signature"];
    if (!header || !header.startsWith("sha256=")) {
      return { valid: false, reason: "Missing or malformed signature header." };
    }
    const provided = header.slice("sha256=".length).trim();
    const expectedHex = createHmac("sha256", this.secret)
      .update(rawBody)
      .digest("hex");

    let signatureOk = false;
    try {
      const providedBuf = Buffer.from(provided, "hex");
      const expectedBuf = Buffer.from(expectedHex, "hex");
      signatureOk =
        providedBuf.length === expectedBuf.length &&
        timingSafeEqual(providedBuf, expectedBuf);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      return { valid: false, reason: "Signature verification failed." };
    }

    // Signature is good; parse the normalised body.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { valid: false, reason: "Malformed JSON body." };
    }

    const circleId =
      typeof parsed.circleId === "string" ? parsed.circleId : undefined;
    const externalRef =
      typeof parsed.externalRef === "string" ? parsed.externalRef : undefined;
    const active = parsed.active === true;
    const interval =
      parsed.interval === "MONTHLY" || parsed.interval === "ANNUAL"
        ? (parsed.interval as BillingInterval)
        : undefined;

    return {
      valid: true,
      active,
      ...(circleId !== undefined ? { circleId } : {}),
      ...(externalRef !== undefined ? { externalRef } : {}),
      ...(interval !== undefined ? { interval } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Admin error queue seam (R21.20).
// ---------------------------------------------------------------------------

/** A webhook that failed verification or processing, for admin re-drive. */
export interface WebhookFailure {
  provider: SubscriptionProvider;
  /** Raw payload bytes, base64-encoded for durable inspect/edit/re-drive. */
  rawBodyBase64: string;
  /** Why processing failed. */
  reason: string;
  /** When the failure was recorded (ISO-8601). */
  at: string;
}

/**
 * Seam a failed subscription webhook is routed to (R21.20). No dedicated Prisma
 * model exists yet, so the default is in-memory; the Admin console can swap a
 * durable store implementing the same interface later. The Admin error-queue
 * routes (task 19.1) present these with inspect/edit/re-drive options.
 */
export interface AdminErrorQueue {
  push(failure: WebhookFailure): Promise<void>;
}

/** Default in-memory error queue. Exposes `items` for assertions/dev inspection. */
export class InMemoryAdminErrorQueue implements AdminErrorQueue {
  readonly items: WebhookFailure[] = [];
  async push(failure: WebhookFailure): Promise<void> {
    this.items.push(failure);
  }
}

// ---------------------------------------------------------------------------
// 4. Trial-reminder decision (pure) + emission seam (R20.9).
// ---------------------------------------------------------------------------

/** Which trial reminder is due, if any. */
export type TrialReminderKind = "FOUR_DAY" | "ONE_DAY" | null;

/** Milliseconds in one day. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PURE decision: given `trialEndsAt` and the current `now`, return which trial
 * reminder is due (R20.9). A reminder is due for the day it "crosses into":
 *   - FOUR_DAY when 3 days < timeLeft <= 4 days,
 *   - ONE_DAY  when 0 days < timeLeft <= 1 day,
 *   - null otherwise (including after expiry).
 * The half-open day buckets make the decision idempotent for a daily cron: a
 * given reminder fires on exactly one calendar day of the countdown.
 */
export function computeDueTrialReminder(
  trialEndsAt: Date,
  now: Date,
): TrialReminderKind {
  const msLeft = trialEndsAt.getTime() - now.getTime();
  if (msLeft <= 0) return null;
  if (msLeft > 3 * ONE_DAY_MS && msLeft <= 4 * ONE_DAY_MS) return "FOUR_DAY";
  if (msLeft > 0 && msLeft <= ONE_DAY_MS) return "ONE_DAY";
  return null;
}

/** A single trial reminder to deliver to one Observer. */
export interface TrialReminder {
  circleId: string;
  observerId: string;
  kind: Exclude<TrialReminderKind, null>;
  trialEndsAt: string;
}

/**
 * Emission seam for the non-intrusive trial status update (R20.9). The
 * worker/cron computes due reminders with `computeDueTrialReminder` and hands
 * them here for per-Observer delivery (push/WhatsApp). Default is in-memory.
 */
export interface TrialReminderScheduler {
  deliver(reminder: TrialReminder): Promise<void>;
}

/** Default in-memory reminder scheduler. Exposes `sent` for assertions. */
export class InMemoryTrialReminderScheduler implements TrialReminderScheduler {
  readonly sent: TrialReminder[] = [];
  async deliver(reminder: TrialReminder): Promise<void> {
    this.sent.push(reminder);
  }
}

// ---------------------------------------------------------------------------
// 5. Checkout provider seam.
// ---------------------------------------------------------------------------

/** A begun checkout the caller completes off-platform. */
export interface CheckoutSession {
  /** URL/deeplink the client opens to complete payment. */
  checkoutUrl: string;
  /** Opaque provider reference for this checkout attempt. */
  reference: string;
}

/** Seam `POST /subscriptions/checkout` uses to begin an off-platform purchase. */
export interface CheckoutProvider {
  createSession(input: {
    circleId: string;
    interval: BillingInterval;
  }): Promise<CheckoutSession>;
}

/**
 * Default dev/test checkout provider: returns a deterministic dev URL. The live
 * adapter (StoreKit / Play Billing / UPI Autopay mandate creation) implements
 * the same interface.
 */
export class MockCheckoutProvider implements CheckoutProvider {
  constructor(private readonly baseUrl = "https://checkout.kshema.dev") {}
  async createSession(input: {
    circleId: string;
    interval: BillingInterval;
  }): Promise<CheckoutSession> {
    const reference = `chk_${input.circleId}_${input.interval}`;
    return {
      checkoutUrl: `${this.baseUrl}/${input.interval.toLowerCase()}?circle=${encodeURIComponent(
        input.circleId,
      )}&ref=${encodeURIComponent(reference)}`,
      reference,
    };
  }
}

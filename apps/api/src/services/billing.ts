/**
 * Self-service billing seams (task 20.2 — R28.16, R28.17).
 *
 * The web billing routes depend only on these interfaces so the concrete
 * payment integrations (Stripe Customer Portal for international cards,
 * Razorpay for recurring regional mandates) can land later without route
 * churn — exactly the pattern the subscription webhook verifier / checkout
 * provider already use.
 *
 *   1. `BillingPortalProvider` — mints a hosted customer-portal / subscription-
 *      management session and returns the redirect URL the browser opens
 *      (R28.16). The default `MockBillingPortalProvider` returns a
 *      deterministic dev URL.
 *
 *   2. `InvoiceStore` — lists a Circle's tax-compliant invoices and resolves a
 *      single invoice's PDF bytes for download (R28.17). No dedicated Prisma
 *      model exists yet, so the default is an in-memory store; a durable
 *      store / provider-backed invoice API implements the same interface.
 */
import type { BillingInterval, InvoiceSummary } from "@kshema/types";

// ---------------------------------------------------------------------------
// 1. Billing portal session (R28.16).
// ---------------------------------------------------------------------------

/** A begun hosted billing-portal session the browser redirects to. */
export interface BillingPortalSession {
  /** URL the client opens to manage payment methods / subscription. */
  redirectUrl: string;
}

/** Seam `POST /web/billing/portal-session` uses to open a hosted portal. */
export interface BillingPortalProvider {
  createSession(input: {
    circleId: string;
    /** Where the portal returns the user afterwards, when supported. */
    returnUrl?: string;
  }): Promise<BillingPortalSession>;
}

/**
 * Default dev/test portal provider: returns a deterministic dev URL. The live
 * adapter (Stripe `billingPortal.sessions.create` / Razorpay subscription
 * management) implements the same interface.
 */
export class MockBillingPortalProvider implements BillingPortalProvider {
  constructor(private readonly baseUrl = "https://billing.kshema.dev/portal") {}
  async createSession(input: {
    circleId: string;
    returnUrl?: string;
  }): Promise<BillingPortalSession> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("circle", input.circleId);
    if (input.returnUrl) url.searchParams.set("return", input.returnUrl);
    return { redirectUrl: url.toString() };
  }
}

// ---------------------------------------------------------------------------
// 2. Invoice store (R28.17).
// ---------------------------------------------------------------------------

/** A tax-compliant invoice PDF resolved for download. */
export interface InvoicePdf {
  /** Raw PDF bytes. */
  bytes: Buffer;
  /** Suggested download filename (e.g. `kshema-invoice-<id>.pdf`). */
  filename: string;
}

/** Seam the web billing routes use to list + download invoices (R28.17). */
export interface InvoiceStore {
  list(input: { circleId: string }): Promise<InvoiceSummary[]>;
  /** Resolve one invoice's PDF; `undefined` when it is unknown for the circle. */
  getPdf(input: {
    circleId: string;
    invoiceId: string;
  }): Promise<InvoicePdf | undefined>;
}

/**
 * Default in-memory invoice store. Seeds nothing by default (a new Circle has
 * no invoices); tests / dev may pre-load `invoices` and `pdfs`. A durable /
 * provider-backed store implements the same interface later.
 */
export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly invoices: Map<string, InvoiceSummary[]>;
  private readonly pdfs: Map<string, Buffer>;

  constructor(seed?: {
    invoices?: Record<string, InvoiceSummary[]>;
    pdfs?: Record<string, Buffer>;
  }) {
    this.invoices = new Map(Object.entries(seed?.invoices ?? {}));
    this.pdfs = new Map(Object.entries(seed?.pdfs ?? {}));
  }

  async list(input: { circleId: string }): Promise<InvoiceSummary[]> {
    return this.invoices.get(input.circleId) ?? [];
  }

  async getPdf(input: {
    circleId: string;
    invoiceId: string;
  }): Promise<InvoicePdf | undefined> {
    // Only resolve invoices that belong to this circle.
    const owned = (this.invoices.get(input.circleId) ?? []).some(
      (i) => i.id === input.invoiceId,
    );
    if (!owned) return undefined;
    const bytes = this.pdfs.get(input.invoiceId);
    if (!bytes) return undefined;
    return { bytes, filename: `kshema-invoice-${input.invoiceId}.pdf` };
  }
}

// ---------------------------------------------------------------------------
// Billing-interval switch (R28.17). PURE guard: only a PRO subscription may
// switch between MONTHLY and ANNUAL. A TRIAL / SHIELD_PAUSED subscription has
// no active paid interval to switch, and a no-op (same interval) is rejected so
// the caller sees an explicit outcome.
// ---------------------------------------------------------------------------

export interface IntervalSwitchOk {
  ok: true;
  interval: BillingInterval;
}
export interface IntervalSwitchErr {
  ok: false;
  reason: string;
}
export type IntervalSwitchResult = IntervalSwitchOk | IntervalSwitchErr;

/**
 * Decide whether a Circle may switch its Pro billing interval (R28.17). Only a
 * PRO tier may switch; switching to the interval already in effect is a no-op
 * and rejected.
 */
export function decideIntervalSwitch(
  tier: "TRIAL" | "PRO" | "SHIELD_PAUSED",
  currentInterval: BillingInterval | null | undefined,
  requested: BillingInterval,
): IntervalSwitchResult {
  if (tier !== "PRO") {
    return {
      ok: false,
      reason: `Only an active Pro subscription can switch billing intervals (current tier: ${tier}).`,
    };
  }
  if (currentInterval === requested) {
    return {
      ok: false,
      reason: `The subscription is already billed ${requested.toLowerCase()}.`,
    };
  }
  return { ok: true, interval: requested };
}

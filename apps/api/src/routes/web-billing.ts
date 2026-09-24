/**
 * Web self-service billing (task 20.2 — R28.16, R28.17, R20).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `POST /api/v1/web/billing/portal-session`        open hosted billing portal
 *   - `GET  /api/v1/web/billing/summary`               tier + trial countdown + interval
 *   - `POST /api/v1/web/billing/interval`              switch MONTHLY <-> ANNUAL Pro
 *   - `GET  /api/v1/web/billing/invoices`              list tax-compliant invoices
 *   - `GET  /api/v1/web/billing/invoices/:id.pdf`      download one invoice PDF
 *
 * All routes require a valid web session (`app.authenticate`).
 *
 * ---------------------------------------------------------------------------
 * CIRCLE RESOLUTION. Every billing operation targets the CALLER'S Circle,
 * derived from their most recent CircleMember row (any role may manage the
 * shared shield's billing). A caller with no Circle membership is `403`.
 *
 * PORTAL SESSION (R28.16). Delegates to the injectable `BillingPortalProvider`
 * (Stripe Customer Portal for international cards / Razorpay for regional
 * mandates) and returns the redirect URL the browser opens.
 *
 * SUMMARY (R28.17). Returns the active `Subscription_Tier`, the trial
 * expiration countdown (`trialEndsAt` + whole days remaining, floored at 0),
 * and the current `BillingInterval` when on Pro.
 *
 * INTERVAL SWITCH (R28.17). `{ interval: MONTHLY|ANNUAL }` switches a PRO
 * subscription between monthly and annual billing through the pure
 * `decideIntervalSwitch` guard; a non-Pro tier or a no-op switch is `400`.
 *
 * INVOICES (R28.17). Lists tax-compliant invoices and streams a single
 * invoice's PDF for download, both behind the injectable `InvoiceStore`. The
 * `:id.pdf` path segment carries a trailing `.pdf` the handler strips before
 * lookup; an unknown invoice (or one not owned by the caller's Circle) is
 * `404`.
 *
 * NO location / chat / other Anchor PII is ever emitted by these routes.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  BillingIntervalSwitchSchema,
  BillingPortalSessionResponseSchema,
  BillingSummarySchema,
  InvoiceIdParamSchema,
  InvoiceListResponseSchema,
} from "@kshema/types";
import {
  MockBillingPortalProvider,
  InMemoryInvoiceStore,
  decideIntervalSwitch,
  type BillingPortalProvider,
  type InvoiceStore,
} from "../services/billing.js";

const ForbiddenSchema = z
  .object({ error: z.literal("Forbidden"), message: z.string().min(1) })
  .strict();
const BadRequestSchema = z
  .object({ error: z.literal("Bad Request"), message: z.string().min(1) })
  .strict();
const NotFoundSchema = z
  .object({ error: z.literal("Not Found"), message: z.string().min(1) })
  .strict();

/** Optional return URL for the hosted portal. */
const PortalSessionBodySchema = z
  .object({
    returnUrl: z.string().trim().url().optional(),
  })
  .strict();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface WebBillingRouteDeps {
  /** Hosted billing-portal provider seam (Stripe / Razorpay). */
  portalProvider?: BillingPortalProvider;
  /** Invoice list + PDF store seam. */
  invoiceStore?: InvoiceStore;
  /** Clock injection for a deterministic trial countdown in tests. */
  now?: () => number;
}

export async function webBillingRoutes(
  app: FastifyInstance,
  deps: WebBillingRouteDeps = {},
): Promise<void> {
  const {
    portalProvider = new MockBillingPortalProvider(),
    invoiceStore = new InMemoryInvoiceStore(),
    now = Date.now,
  } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  /** Resolve the caller's Circle id, or `undefined` when they have none. */
  async function resolveCircleId(userId: string): Promise<string | undefined> {
    const membership = await app.prisma.circleMember.findFirst({
      where: { userId, role: { in: ["ANCHOR", "OBSERVER", "MUTUAL"] } },
      select: { circleId: true },
    });
    return membership?.circleId;
  }

  // -------------------------------------------------------------------------
  // POST /web/billing/portal-session (R28.16).
  // -------------------------------------------------------------------------
  typed.post(
    "/web/billing/portal-session",
    {
      onRequest: [app.authenticate],
      schema: {
        body: PortalSessionBodySchema,
        response: {
          200: BillingPortalSessionResponseSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const circleId = await resolveCircleId(request.user.sub);
      if (!circleId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only a Circle member may manage billing.",
        });
      }
      const session = await portalProvider.createSession({
        circleId,
        ...(request.body.returnUrl !== undefined
          ? { returnUrl: request.body.returnUrl }
          : {}),
      });
      return { redirectUrl: session.redirectUrl };
    },
  );

  // -------------------------------------------------------------------------
  // GET /web/billing/summary (R28.17).
  // -------------------------------------------------------------------------
  typed.get(
    "/web/billing/summary",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: BillingSummarySchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const circleId = await resolveCircleId(request.user.sub);
      if (!circleId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only a Circle member may view billing.",
        });
      }
      const subscription = await app.prisma.subscription.findUnique({
        where: { circleId },
        select: { tier: true, interval: true, trialEndsAt: true },
      });
      if (!subscription) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "No subscription exists for this Circle.",
        });
      }

      const msLeft = subscription.trialEndsAt.getTime() - now();
      const trialDaysRemaining = Math.max(0, Math.ceil(msLeft / ONE_DAY_MS));

      return {
        tier: subscription.tier,
        ...(subscription.interval ? { interval: subscription.interval } : {}),
        trialEndsAt: subscription.trialEndsAt.toISOString(),
        trialDaysRemaining,
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /web/billing/interval (R28.17) — switch MONTHLY <-> ANNUAL Pro.
  // -------------------------------------------------------------------------
  typed.post(
    "/web/billing/interval",
    {
      onRequest: [app.authenticate],
      schema: {
        body: BillingIntervalSwitchSchema,
        response: {
          200: BillingSummarySchema,
          400: BadRequestSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const circleId = await resolveCircleId(request.user.sub);
      if (!circleId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only a Circle member may manage billing.",
        });
      }
      const subscription = await app.prisma.subscription.findUnique({
        where: { circleId },
        select: { id: true, tier: true, interval: true, trialEndsAt: true },
      });
      if (!subscription) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "No subscription exists for this Circle.",
        });
      }

      const decision = decideIntervalSwitch(
        subscription.tier,
        subscription.interval,
        request.body.interval,
      );
      if (!decision.ok) {
        return reply.code(400).send({
          error: "Bad Request" as const,
          message: decision.reason,
        });
      }

      await app.prisma.subscription.update({
        where: { id: subscription.id },
        data: { interval: decision.interval },
      });

      const msLeft = subscription.trialEndsAt.getTime() - now();
      const trialDaysRemaining = Math.max(0, Math.ceil(msLeft / ONE_DAY_MS));

      return {
        tier: subscription.tier,
        interval: decision.interval,
        trialEndsAt: subscription.trialEndsAt.toISOString(),
        trialDaysRemaining,
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /web/billing/invoices (R28.17) — list tax-compliant invoices.
  // -------------------------------------------------------------------------
  typed.get(
    "/web/billing/invoices",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: InvoiceListResponseSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const circleId = await resolveCircleId(request.user.sub);
      if (!circleId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only a Circle member may view invoices.",
        });
      }
      const invoices = await invoiceStore.list({ circleId });
      return { invoices };
    },
  );

  // -------------------------------------------------------------------------
  // GET /web/billing/invoices/:id.pdf (R28.17) — download one invoice PDF.
  // The captured `:id.pdf` param carries the trailing `.pdf`; strip it.
  // -------------------------------------------------------------------------
  typed.get(
    "/web/billing/invoices/:id.pdf",
    {
      onRequest: [app.authenticate],
      schema: {
        params: InvoiceIdParamSchema,
        response: {
          403: ForbiddenSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const circleId = await resolveCircleId(request.user.sub);
      if (!circleId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only a Circle member may download invoices.",
        });
      }

      // Fastify captures the segment including the trailing `.pdf`.
      const raw = request.params.id;
      const invoiceId = raw.endsWith(".pdf") ? raw.slice(0, -".pdf".length) : raw;

      const pdf = await invoiceStore.getPdf({ circleId, invoiceId });
      if (!pdf) {
        return reply.code(404).send({
          error: "Not Found" as const,
          message: "That invoice could not be found for your Circle.",
        });
      }

      // The PDF is a binary body, not one of the typed JSON response shapes, so
      // stream it through the raw reply (bypassing the Zod serializer).
      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${pdf.filename}"`);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
      });
      reply.raw.end(pdf.bytes);
      return reply;
    },
  );
}

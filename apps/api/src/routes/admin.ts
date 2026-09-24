/**
 * Admin console API routes (task 19.1 — R21).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `GET   /api/v1/admin/fleet/pulse`                 fleet telemetry pulse (R21.15, R21.16)
 *   - `GET   /api/v1/admin/carrier/health`              carrier gateway health (R21.13, R21.14)
 *   - `GET   /api/v1/admin/incidents/live`              live incident ops monitor (R21.10)
 *   - `POST  /api/v1/admin/incidents/:id/retry-dispatch` manual carrier fallback (R21.12)
 *   - `GET   /api/v1/admin/subscriptions`               subscription statuses (R21.3)
 *   - `PATCH /api/v1/admin/circles/:id/trial`           trial extension / restore (R21.19)
 *   - `POST  /api/v1/admin/users/:id/purge-request`     DPDP/GDPR purge (R21.21)
 *   - `POST  /api/v1/admin/devices/:id/wakefulness-test` silent push ping (R21.18)
 *   - `GET   /api/v1/admin/webhooks/error-queue`        failed-webhook error queue (R21.20)
 *
 * ---------------------------------------------------------------------------
 * AdminAuthGuard (R21.1, R21.5). Every route is protected by `adminGuard(cap)`,
 * a per-capability `onRequest` guard. It:
 *   1. verifies the admin bearer token via the injectable `AdminSessionVerifier`
 *      (MFA + single role). A missing/invalid token, or a token whose MFA claim
 *      is not satisfied, is rejected `401` (R21.1).
 *   2. checks the single role against the PURE RBAC matrix for the route's
 *      capability. An out-of-role attempt is rejected `403` AND records a
 *      SECURITY_VIOLATION entry in the append-only Admin_Audit_Ledger (R21.5).
 * The verified session is stashed on `request.adminSession` for the handler.
 *
 * AUDIT LEDGER (R21.9). Every successful handler writes an `AdminAuditLog` row
 * (timestamp, admin id, source IP, target entity, justification) via the shared
 * `audit()` helper, classified by `AuditAction` (VIEW/QUERY/MUTATION/EXPORT).
 * The guard writes SECURITY_VIOLATION rows on denial. The ledger is append-only
 * — handlers only ever create rows, never update/delete them.
 *
 * PRIVACY INVIOLABILITY (R21.6, R21.7, R21.8). No route decrypts an
 * Encrypted_Black_Box or initiates live GPS/audio — no such path exists here.
 * Every rendered phone number is masked to its last 4 digits via `maskPhone`
 * except within an active Stage-4 triage session opened by an authorized
 * SUPPORT_AGENT (R21.8).
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  RetryDispatchSchema,
  RetryDispatchAckSchema,
  TrialExtensionSchema,
  TrialExtensionResultSchema,
  PurgeRequestSchema,
  PurgeRequestAckSchema,
  WakefulnessTestSchema,
  WakefulnessTestAckSchema,
  FleetPulseSchema,
  CarrierHealthSchema,
  LiveIncidentSchema,
  AdminSubscriptionRowSchema,
  WebhookErrorItemSchema,
  type AuditAction,
} from "@kshema/types";
import {
  isPermitted,
  maskPhone,
  isTelemetryAtRisk,
  computeCarrierErrorRate,
  exceedsCarrierAlertThreshold,
  CARRIER_ALERT_WINDOW_MS,
  PURGE_GRACE_MS,
  JwtAdminSessionVerifier,
  InMemoryOnCallAlerter,
  InMemoryWakefulnessPinger,
  InMemoryPurgeScheduler,
  type AdminCapability,
  type AdminSession,
  type AdminSessionVerifier,
  type OnCallAlerter,
  type WakefulnessPinger,
  type PurgeScheduler,
} from "../services/admin.js";
import {
  applyTrialExtension,
  InMemoryAdminErrorQueue,
  type AdminErrorQueue,
} from "../services/subscriptions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The verified admin identity, set by `adminGuard`. */
    adminSession?: AdminSession;
  }
}

/** Descriptive error envelopes (mirroring the other route modules). */
const UnauthorizedSchema = z
  .object({ error: z.literal("Unauthorized"), message: z.string().min(1) })
  .strict();
const ForbiddenSchema = z
  .object({ error: z.literal("Forbidden"), message: z.string().min(1) })
  .strict();
const BadRequestSchema = z
  .object({ error: z.literal("Bad Request"), message: z.string().min(1) })
  .strict();
const NotFoundSchema = z
  .object({ error: z.literal("Not Found"), message: z.string().min(1) })
  .strict();

/** Optional justification query for read routes (R21.9 justification note). */
const JustificationQuery = z
  .object({ justification: z.string().trim().min(1).optional() })
  .strict();

/** Dependencies injected into the admin routes (replaceable in tests). */
export interface AdminRouteDeps {
  /** MFA/RBAC identity seam; defaults to a JWT-backed verifier over `app.jwt`. */
  sessionVerifier?: AdminSessionVerifier;
  /** On-call pager seam for the carrier error-rate alert (R21.14). */
  onCallAlerter?: OnCallAlerter;
  /** Silent device-ping seam for the wakefulness test (R21.18). */
  wakefulnessPinger?: WakefulnessPinger;
  /** Purge-scheduling seam for the DPDP/GDPR grace window (R21.21). */
  purgeScheduler?: PurgeScheduler;
  /**
   * The shared subscription-webhook error queue (R21.20). The admin
   * error-queue route reads from the SAME instance the subscription webhook
   * route writes to, so a failed receipt is inspectable here.
   */
  errorQueue?: AdminErrorQueue;
  /** Clock injection for deterministic audit timestamps / windows in tests. */
  now?: () => number;
}

export async function adminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps = {},
): Promise<void> {
  const {
    sessionVerifier = new JwtAdminSessionVerifier(app.jwt),
    onCallAlerter = new InMemoryOnCallAlerter(),
    wakefulnessPinger = new InMemoryWakefulnessPinger(),
    purgeScheduler = new InMemoryPurgeScheduler(),
    errorQueue = new InMemoryAdminErrorQueue(),
    now = Date.now,
  } = deps;

  const typed = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // Audit-ledger helper (R21.9). Appends one append-only AdminAuditLog row.
  // Never throws into the response path — an audit write failure is logged but
  // must not mask the handler's own outcome.
  // -------------------------------------------------------------------------
  const audit = async (params: {
    adminUserId: string;
    action: AuditAction;
    sourceIp: string;
    targetEntity: string;
    justification?: string;
  }): Promise<void> => {
    try {
      await app.prisma.adminAuditLog.create({
        data: {
          adminUserId: params.adminUserId,
          action: params.action,
          sourceIp: params.sourceIp,
          targetEntity: params.targetEntity,
          ...(params.justification !== undefined
            ? { justification: params.justification }
            : {}),
        },
      });
    } catch (err) {
      app.log.error(
        { err, targetEntity: params.targetEntity },
        "failed to write AdminAuditLog row",
      );
    }
  };

  /** The best-effort source IP for the audit ledger (proxy-aware). */
  const sourceIpOf = (request: FastifyRequest): string => {
    const fwd = request.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) {
      return fwd.split(",")[0]!.trim();
    }
    return request.ip;
  };

  // -------------------------------------------------------------------------
  // adminGuard — per-capability MFA + RBAC guard (R21.1, R21.5). Verifies the
  // admin session, enforces MFA, and checks the single role against the RBAC
  // matrix. An out-of-role attempt is denied 403 AND audited as a
  // SECURITY_VIOLATION (R21.5); a missing/invalid/non-MFA token is 401.
  // -------------------------------------------------------------------------
  const adminGuard = (capability: AdminCapability): onRequestHookHandler => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const session = sessionVerifier.verify(request.headers.authorization);
      if (!session) {
        return reply.code(401).send({
          error: "Unauthorized" as const,
          message: "Missing or invalid admin token.",
        });
      }
      if (!session.mfa) {
        return reply.code(401).send({
          error: "Unauthorized" as const,
          message: "Multi-factor authentication is required for the admin console.",
        });
      }
      request.adminSession = session;

      if (!isPermitted(session.role, capability)) {
        // Record the SECURITY_VIOLATION before replying (R21.5). The target
        // entity captures the attempted capability + path for the ledger.
        await audit({
          adminUserId: session.adminUserId,
          action: "SECURITY_VIOLATION",
          sourceIp: sourceIpOf(request),
          targetEntity: `${capability} ${request.method} ${request.url}`,
          justification: `Out-of-role attempt by ${session.role}.`,
        });
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "This action is not permitted for your admin role.",
        });
      }
    };
  };

  // =========================================================================
  // GET /admin/fleet/pulse — aggregated fleet telemetry pulse (R21.15, R21.16).
  // Counts active circles, telemetry-at-risk devices (>= 45m silent), and open
  // incidents. VIEW audit.
  // =========================================================================
  typed.get(
    "/admin/fleet/pulse",
    {
      onRequest: [adminGuard("FLEET_PULSE_VIEW")],
      schema: {
        querystring: JustificationQuery,
        response: {
          200: FleetPulseSchema,
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request) => {
      const session = request.adminSession!;
      const nowDate = new Date(now());

      const [activeCircles, openIncidents, devices] = await Promise.all([
        app.prisma.circle.count(),
        app.prisma.safetyIncident.count({ where: { status: "OPEN" } }),
        app.prisma.deviceConfig.findMany({
          select: { lastTelemetrySyncAt: true },
        }),
      ]);

      const telemetryAtRisk = devices.filter((d) =>
        isTelemetryAtRisk(d.lastTelemetrySyncAt, nowDate),
      ).length;

      await audit({
        adminUserId: session.adminUserId,
        action: "VIEW",
        sourceIp: sourceIpOf(request),
        targetEntity: "fleet/pulse",
        ...(request.query.justification !== undefined
          ? { justification: request.query.justification }
          : {}),
      });

      return { activeCircles, telemetryAtRisk, openIncidents };
    },
  );

  // =========================================================================
  // GET /admin/carrier/health — carrier gateway health (R21.13) + on-call trip
  // (R21.14). For each gateway we compute the rolling 15-minute error rate; if
  // it exceeds 5% we fire the on-call alert seam. QUERY audit.
  // =========================================================================
  typed.get(
    "/admin/carrier/health",
    {
      onRequest: [adminGuard("CARRIER_HEALTH_VIEW")],
      schema: {
        querystring: JustificationQuery,
        response: {
          200: z.array(CarrierHealthSchema),
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request) => {
      const session = request.adminSession!;
      const nowMs = now();
      const windowStart = new Date(nowMs - CARRIER_ALERT_WINDOW_MS);

      // Rolling window: the metric rows recorded within the last 15 minutes.
      const metrics = await app.prisma.carrierGatewayMetric.findMany({
        where: { windowStart: { gte: windowStart } },
        orderBy: { windowStart: "desc" },
      });

      // Aggregate failed/total per gateway from the persisted samples. We treat
      // `errorRate` as the per-sample fraction and average across the window's
      // samples per gateway (each sample already summarises its own sub-window).
      const byGateway = new Map<
        string,
        { rateSum: number; count: number; latencySum: number; latencyN: number; earliest: Date }
      >();
      for (const m of metrics) {
        const g = byGateway.get(m.gateway) ?? {
          rateSum: 0,
          count: 0,
          latencySum: 0,
          latencyN: 0,
          earliest: m.windowStart,
        };
        g.rateSum += m.errorRate ?? 0;
        g.count += 1;
        if (m.deliveryLatencyMs != null) {
          g.latencySum += m.deliveryLatencyMs;
          g.latencyN += 1;
        }
        if (m.windowStart < g.earliest) g.earliest = m.windowStart;
        byGateway.set(m.gateway, g);
      }

      const rows = [];
      for (const [gateway, agg] of byGateway) {
        const errorRate = computeCarrierErrorRate(agg.rateSum, agg.count);
        // Fire the high-priority on-call alert when the rolling rate > 5% (R21.14).
        if (exceedsCarrierAlertThreshold(errorRate)) {
          await onCallAlerter.fire({
            gateway,
            errorRate,
            windowStart: agg.earliest.toISOString(),
            firedAt: new Date(nowMs).toISOString(),
          });
        }
        rows.push({
          gateway,
          errorRate,
          ...(agg.latencyN > 0
            ? { deliveryLatencyMs: Math.round(agg.latencySum / agg.latencyN) }
            : {}),
          windowStart: agg.earliest.toISOString(),
        });
      }

      await audit({
        adminUserId: session.adminUserId,
        action: "QUERY",
        sourceIp: sourceIpOf(request),
        targetEntity: "carrier/health",
        ...(request.query.justification !== undefined
          ? { justification: request.query.justification }
          : {}),
      });

      return rows;
    },
  );

  // =========================================================================
  // GET /admin/incidents/live — real-time monitor of active incidents (R21.10).
  // Anchor phone masked to last 4 digits (R21.8); no Stage-4 triage session is
  // opened on this read, so masking always applies here. VIEW audit.
  // =========================================================================
  typed.get(
    "/admin/incidents/live",
    {
      onRequest: [adminGuard("LIVE_INCIDENTS_VIEW")],
      schema: {
        querystring: JustificationQuery,
        response: {
          200: z.array(LiveIncidentSchema),
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request) => {
      const session = request.adminSession!;

      const incidents = await app.prisma.safetyIncident.findMany({
        where: { status: "OPEN" },
        orderBy: { openedAt: "desc" },
        select: {
          id: true,
          stage: true,
          status: true,
          anchorId: true,
          openedAt: true,
        },
      });

      // Resolve each anchor's phone for masked display. A plain list read never
      // opens a Stage-4 triage session, so phones are always masked here (R21.8).
      const anchorIds = [...new Set(incidents.map((i) => i.anchorId))];
      const anchors = anchorIds.length
        ? await app.prisma.user.findMany({
            where: { id: { in: anchorIds } },
            select: { id: true, phone: true },
          })
        : [];
      const phoneById = new Map(anchors.map((a) => [a.id, a.phone]));

      await audit({
        adminUserId: session.adminUserId,
        action: "VIEW",
        sourceIp: sourceIpOf(request),
        targetEntity: "incidents/live",
        ...(request.query.justification !== undefined
          ? { justification: request.query.justification }
          : {}),
      });

      return incidents.map((i) => ({
        incidentId: i.id,
        stage: i.stage,
        status: i.status,
        maskedAnchorPhone: maskPhone(phoneById.get(i.anchorId) ?? ""),
        openedAt: i.openedAt.toISOString(),
      }));
    },
  );

  // =========================================================================
  // POST /admin/incidents/:id/retry-dispatch — manual alternate-carrier
  // fallback for a failed dispatch during an active incident (R21.12). Emits
  // `incident.retry-dispatch` for the worker to perform the actual carrier
  // fallback; the admin surface never carries a black-box or location payload.
  // MUTATION audit.
  // =========================================================================
  typed.post(
    "/admin/incidents/:id/retry-dispatch",
    {
      onRequest: [adminGuard("RETRY_DISPATCH")],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        body: RetryDispatchSchema,
        response: {
          200: RetryDispatchAckSchema,
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const session = request.adminSession!;
      const { id: incidentId } = request.params;
      const { justification } = request.body;

      const incident = await app.prisma.safetyIncident.findUnique({
        where: { id: incidentId },
        select: { id: true, circleId: true, status: true },
      });
      if (!incident || incident.status !== "OPEN") {
        return reply.code(404).send({
          error: "Not Found" as const,
          message: "No active incident with that id.",
        });
      }

      await app.events.emit("incident.retry-dispatch", {
        incidentId: incident.id,
        circleId: incident.circleId,
        requestedByAdminId: session.adminUserId,
      });

      await audit({
        adminUserId: session.adminUserId,
        action: "MUTATION",
        sourceIp: sourceIpOf(request),
        targetEntity: `incident:${incident.id}`,
        ...(justification !== undefined ? { justification } : {}),
      });

      return { incidentId: incident.id, dispatched: true as const };
    },
  );

  // =========================================================================
  // GET /admin/subscriptions — subscription statuses (R21.3). QUERY audit.
  // =========================================================================
  typed.get(
    "/admin/subscriptions",
    {
      onRequest: [adminGuard("SUBSCRIPTIONS_VIEW")],
      schema: {
        querystring: JustificationQuery,
        response: {
          200: z.array(AdminSubscriptionRowSchema),
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request) => {
      const session = request.adminSession!;

      const subscriptions = await app.prisma.subscription.findMany({
        orderBy: { trialEndsAt: "asc" },
        select: { circleId: true, tier: true, trialEndsAt: true },
      });

      await audit({
        adminUserId: session.adminUserId,
        action: "QUERY",
        sourceIp: sourceIpOf(request),
        targetEntity: "subscriptions",
        ...(request.query.justification !== undefined
          ? { justification: request.query.justification }
          : {}),
      });

      return subscriptions.map((s) => ({
        circleId: s.circleId,
        tier: s.tier,
        trialEndsAt: s.trialEndsAt.toISOString(),
      }));
    },
  );

  // =========================================================================
  // PATCH /admin/circles/:id/trial — grant a trial extension (R21.19). Restores
  // SHIELD_PAUSED -> TRIAL, pushes out the expiry, and emits
  // `subscription.changed` (the worker resumes routines). MUTATION audit.
  // =========================================================================
  typed.patch(
    "/admin/circles/:id/trial",
    {
      onRequest: [adminGuard("TRIAL_EXTENSION")],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        body: TrialExtensionSchema,
        response: {
          200: TrialExtensionResultSchema,
          400: BadRequestSchema,
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const session = request.adminSession!;
      const { id: circleId } = request.params;
      const { additionalDays, justification } = request.body;

      const result = await applyTrialExtension(
        app.prisma,
        app.events,
        circleId,
        additionalDays,
        new Date(now()),
      );

      if (!result.applied) {
        // Unknown subscription -> 404; illegal state (e.g. PRO) -> 400.
        const missing = result.reason?.startsWith("No subscription");
        return reply.code(missing ? 404 : 400).send({
          error: (missing ? "Not Found" : "Bad Request") as never,
          message: result.reason ?? "Trial extension could not be applied.",
        });
      }

      // Record the reason on the audit ledger (R21.19 "record the reason").
      await audit({
        adminUserId: session.adminUserId,
        action: "MUTATION",
        sourceIp: sourceIpOf(request),
        targetEntity: `circle:${circleId}`,
        justification,
      });

      return {
        circleId,
        previousTier: result.previousTier!,
        tier: result.tier!,
        trialEndsAt: result.trialEndsAt!.toISOString(),
      };
    },
  );

  // =========================================================================
  // POST /admin/users/:id/purge-request — schedule a DPDP/GDPR cryptographic
  // purge with a 30-day grace (R21.21). Records the request in the purge
  // scheduler seam; the actual deletion runs after the grace elapses (worker).
  // MUTATION audit. SUPER_ADMIN only.
  // =========================================================================
  typed.post(
    "/admin/users/:id/purge-request",
    {
      onRequest: [adminGuard("PURGE_REQUEST")],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        body: PurgeRequestSchema,
        response: {
          200: PurgeRequestAckSchema,
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const session = request.adminSession!;
      const { id: userId } = request.params;
      const { justification } = request.body;

      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        return reply.code(404).send({
          error: "Not Found" as const,
          message: "No such user.",
        });
      }

      const requestedAtMs = now();
      const purgeAfter = new Date(requestedAtMs + PURGE_GRACE_MS);
      await purgeScheduler.schedule({
        userId,
        requestedByAdminId: session.adminUserId,
        justification,
        requestedAt: new Date(requestedAtMs).toISOString(),
        purgeAfter: purgeAfter.toISOString(),
      });

      await audit({
        adminUserId: session.adminUserId,
        action: "MUTATION",
        sourceIp: sourceIpOf(request),
        targetEntity: `user:${userId}`,
        justification,
      });

      return {
        userId,
        scheduled: true as const,
        purgeAfter: purgeAfter.toISOString(),
      };
    },
  );

  // =========================================================================
  // POST /admin/devices/:id/wakefulness-test — silent high-priority push ping
  // to a target Anchor device (R21.18). MUTATION audit.
  // =========================================================================
  typed.post(
    "/admin/devices/:id/wakefulness-test",
    {
      onRequest: [adminGuard("WAKEFULNESS_TEST")],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        body: WakefulnessTestSchema,
        response: {
          200: WakefulnessTestAckSchema,
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const session = request.adminSession!;
      const { id: deviceId } = request.params;
      const { justification } = request.body;

      const device = await app.prisma.deviceConfig.findUnique({
        where: { id: deviceId },
        select: { id: true, userId: true },
      });
      if (!device) {
        return reply.code(404).send({
          error: "Not Found" as const,
          message: "No such device.",
        });
      }

      const owner = await app.prisma.user.findUnique({
        where: { id: device.userId },
        select: { pushTokens: true },
      });

      await wakefulnessPinger.ping({
        deviceId: device.id,
        pushTokens: owner?.pushTokens ?? [],
      });

      await audit({
        adminUserId: session.adminUserId,
        action: "MUTATION",
        sourceIp: sourceIpOf(request),
        targetEntity: `device:${deviceId}`,
        ...(justification !== undefined ? { justification } : {}),
      });

      return { deviceId: device.id, pinged: true as const };
    },
  );

  // =========================================================================
  // GET /admin/webhooks/error-queue — failed subscription/payment webhooks
  // awaiting inspect/edit/re-drive (R21.20). Reads the SAME error-queue seam the
  // subscription webhook route writes to. QUERY audit.
  // =========================================================================
  typed.get(
    "/admin/webhooks/error-queue",
    {
      onRequest: [adminGuard("WEBHOOK_ERROR_QUEUE_VIEW")],
      schema: {
        querystring: JustificationQuery,
        response: {
          200: z.array(WebhookErrorItemSchema),
          401: UnauthorizedSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request) => {
      const session = request.adminSession!;

      // The default in-memory queue exposes `items`; a durable implementation
      // would offer a list method. We read defensively so a non-listable queue
      // simply reports empty rather than throwing.
      const items =
        (errorQueue as { items?: unknown[] }).items ?? [];

      await audit({
        adminUserId: session.adminUserId,
        action: "QUERY",
        sourceIp: sourceIpOf(request),
        targetEntity: "webhooks/error-queue",
        ...(request.query.justification !== undefined
          ? { justification: request.query.justification }
          : {}),
      });

      return items as never;
    },
  );
}

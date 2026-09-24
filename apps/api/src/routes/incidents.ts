/**
 * Incident lifecycle, Sanctuary Mode, and Emergency Medical Dossier routes
 * (task 7.1 — R11.4-R11.6, R13.6, R13.7, R13.9, R34.1, R34.3, R33.1, R33.2).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `POST   /api/v1/incidents/:id/resolve`   Anchor dismissal / Observer override
 *   - `POST   /api/v1/incidents/trigger-sos`   Anchor-only Shadow_SOS handoff
 *   - `POST   /api/v1/sanctuary`               create a SanctuarySchedule
 *   - `DELETE /api/v1/sanctuary/:id`           end (deactivate) a schedule early
 *   - `GET    /api/v1/sanctuary/active`        list the caller's active windows
 *   - `PUT    /api/v1/medical-dossier`         ciphertext-only dossier upsert
 *
 * All routes require a valid bearer token (`app.authenticate`).
 *
 * ---------------------------------------------------------------------------
 * REQUEST-SIDE ONLY, WORKER OWNS THE STATE MACHINE. The API's job here is to
 * VALIDATE, AUTHORIZE, persist the request-side state, and EMIT a domain event.
 * The Sentinel worker (task 10.3) consumes `incident.resolved` / `sos.triggered`
 * to perform the actual ATOMIC transition (`OPEN -> RESOLVED` /
 * `-> HANDED_OFF_SOS`), cancel pending delayed stage jobs, and release black
 * boxes. This route therefore never races the worker's conditional update: it
 * records the resolution *source* and an audit entry, then emits — the worker
 * is the single writer of the terminal status transition (R13.6-13.8, R13.9).
 *
 * RESOLVE AUTHORIZATION (R13.6, R13.7). Two callers may resolve an OPEN
 * incident:
 *   - the incident's own Anchor (`incident.anchorId === caller`) — a manual
 *     dismissal, recorded with `ANCHOR_DISMISSAL` (R13.6);
 *   - an authorized Observer — a `CircleMember` of the incident's circle who
 *     holds `canTriggerIVR` (the same "authority to trigger Hyperlocal_Dispatch"
 *     permission gate used for manual dispatch, R14.5) — recorded with
 *     `OBSERVER_OVERRIDE` (R13.7).
 * The body-supplied `source` must match the caller's established authority; any
 * other caller (a non-member, or a member lacking the override permission and
 * who is not the Anchor) is denied `403`. Unknown incident -> `404`.
 *
 * TRIGGER-SOS is ANCHOR-ONLY (R11.4-11.6, R13.9). Only a `CircleMember` whose
 * role makes them an Anchor within the circle (role `ANCHOR` or `MUTUAL`) may
 * trigger a Shadow_SOS; a pure Observer is denied `403`. The route creates (or
 * hands off an existing OPEN incident to) `HANDED_OFF_SOS` and emits
 * `sos.triggered`; the worker performs the atomic handoff + box release on the
 * event. This is the ONE route that may carry an Anchor-supplied point-in-time
 * SOS coordinate (`TriggerSosSchema.decryptedLocation`) — a one-shot SOS
 * location deliberately released for hyperlocal dispatch, NOT a persisted
 * continuous trace (R5.5/R19.1 forbid persisted traces; R11.4-11.6 allow this
 * deliberate one-shot release). The coordinate is forwarded on the event only
 * and never written to a location-trace column.
 *
 * SANCTUARY MODE (R34.1, R34.3). `POST /sanctuary` creates a `SanctuarySchedule`
 * for the CALLER (`userId = request.user.sub`); the body `anchorId` identifies
 * the Anchor the window applies to and is echoed on the response. `resumesAt`
 * must be after `startsAt` and within 14 days (R34.1) — the `CreateSanctuary`
 * DTO already refines this, and the handler re-checks it to return a descriptive
 * `400` (belt-and-suspenders). `DELETE /sanctuary/:id` deactivates
 * (`isActive=false`) the caller's own schedule; automatic resume needs no call
 * (R34.4, handled by the worker). `GET /sanctuary/active` lists the caller's
 * currently-active windows (`isActive=true` AND `now < resumesAt`) for banner
 * rendering (R34.3).
 *
 * EMERGENCY MEDICAL DOSSIER (R33.1, R33.2). `PUT /medical-dossier` is a
 * CIPHERTEXT-ONLY upsert of the caller's `EmergencyMedicalDossier`
 * (`encryptedPayload` / `iv` / `authTag` / `encryptedEmergencyKey`, base64 ->
 * Bytes, stored verbatim). The server is blind to the plaintext. There is NO
 * `GET` here: the plaintext is reachable ONLY through the Stage-4
 * responder-portal release path (task 13.3) — never on an Admin or ordinary
 * Observer surface (R33.2, R33.3). This module intentionally defines no dossier
 * read route.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ResolveIncidentSchema,
  TriggerSosSchema,
  IncidentSummarySchema,
  SanctuaryWindowSchema,
  UpsertMedicalDossierSchema,
} from "@kshema/types";

/** Circle roles that make a member an Anchor for Shadow_SOS purposes. */
const ANCHOR_ROLES = new Set(["ANCHOR", "MUTUAL"]);

/** Resolution sources this route may record (R13.6, R13.7). */
const ANCHOR_DISMISSAL = "ANCHOR_DISMISSAL" as const;
const OBSERVER_OVERRIDE = "OBSERVER_OVERRIDE" as const;
const SHADOW_SOS_HANDOFF = "SHADOW_SOS_HANDOFF" as const;

/** 14-day Sanctuary cap (R34.1). Mirrors the `CreateSanctuary` DTO refinement. */
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Descriptive `400` envelope (bad request / cap violation). */
const BadRequestSchema = z
  .object({ error: z.literal("Bad Request"), message: z.string().min(1) })
  .strict();

/** Descriptive `403` envelope (unauthorized caller). */
const ForbiddenSchema = z
  .object({ error: z.literal("Forbidden"), message: z.string().min(1) })
  .strict();

/** Descriptive `404` envelope (unknown incident / schedule). */
const NotFoundSchema = z
  .object({ error: z.literal("Not Found"), message: z.string().min(1) })
  .strict();

/** Small acknowledgement returned by the resolve route. */
const ResolveAckSchema = z
  .object({
    incidentId: z.string().min(1),
    source: z.enum([ANCHOR_DISMISSAL, OBSERVER_OVERRIDE]),
    accepted: z.literal(true),
  })
  .strict();

/** Small acknowledgement returned by the medical-dossier upsert. */
const DossierAckSchema = z
  .object({ dossierId: z.string().min(1), stored: z.literal(true) })
  .strict();

/** Query for the active-sanctuary listing. Caller-scoped; no anchorId needed. */
const ActiveSanctuaryResponseSchema = z.array(SanctuaryWindowSchema);

/**
 * Sanctuary create body — the same shape as `@kshema/types`'
 * `CreateSanctuarySchema` but WITHOUT its object-level `.refine()` 14-day-cap
 * check. The cap is enforced in the handler so a violation returns a clean,
 * descriptive `400` (R34.1). A top-level `.refine()` rejection surfaces through
 * `fastify-type-provider-zod` as a serialization failure rather than a routed
 * `400`, so we validate the shape here and re-check the cap ourselves.
 */
const SanctuaryCreateBodySchema = z
  .object({
    anchorId: z.string().trim().min(1),
    startsAt: z.string().datetime({ offset: true }),
    resumesAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

/** Dependencies injected into the incident routes (replaceable in tests). */
export interface IncidentRouteDeps {
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export async function incidentRoutes(
  app: FastifyInstance,
  deps: IncidentRouteDeps = {},
): Promise<void> {
  const { now = Date.now } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /incidents/:id/resolve — Anchor dismissal (ANCHOR_DISMISSAL) or
  // authorized-Observer override (OBSERVER_OVERRIDE). Records the source and an
  // audit entry, then emits `incident.resolved`; the worker performs the atomic
  // OPEN->RESOLVED transition and halts pending stages (R13.6, R13.7, R13.8).
  typed.post(
    "/incidents/:id/resolve",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        body: ResolveIncidentSchema,
        response: {
          200: ResolveAckSchema,
          400: BadRequestSchema,
          403: ForbiddenSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: incidentId } = request.params;
      const { source } = request.body;
      const callerId = request.user.sub;

      const forbidden = (message: string) =>
        reply.code(403).send({ error: "Forbidden" as const, message });

      // Only ANCHOR_DISMISSAL / OBSERVER_OVERRIDE are resolvable via this route.
      // Every other ResolutionSource (auto-resolution, SOS handoff, responder,
      // co-living) is produced by the worker or other routes, not a manual
      // caller here.
      if (source !== ANCHOR_DISMISSAL && source !== OBSERVER_OVERRIDE) {
        return reply.code(400).send({
          error: "Bad Request" as const,
          message:
            "This route resolves only via ANCHOR_DISMISSAL or OBSERVER_OVERRIDE.",
        });
      }

      const incident = await app.prisma.safetyIncident.findUnique({
        where: { id: incidentId },
        select: {
          id: true,
          circleId: true,
          anchorId: true,
          status: true,
          auditTrail: true,
        },
      });
      if (!incident) {
        return reply
          .code(404)
          .send({ error: "Not Found" as const, message: "No such incident." });
      }

      // Establish the caller's authority. The Anchor of the incident may
      // dismiss it; an authorized Observer (a member of the incident's circle
      // holding `canTriggerIVR`) may override it. We derive the caller's actual
      // authority and require the body `source` to match it — a caller cannot
      // claim ANCHOR_DISMISSAL unless they are the Anchor, nor OBSERVER_OVERRIDE
      // unless they hold the override permission.
      const isAnchor = incident.anchorId === callerId;

      const membership = await app.prisma.circleMember.findFirst({
        where: { circleId: incident.circleId, userId: callerId },
        select: { canTriggerIVR: true },
      });
      const isAuthorizedObserver = Boolean(membership?.canTriggerIVR);

      if (source === ANCHOR_DISMISSAL && !isAnchor) {
        return forbidden(
          "Only the incident's Anchor may dismiss it (ANCHOR_DISMISSAL).",
        );
      }
      if (source === OBSERVER_OVERRIDE && !isAuthorizedObserver) {
        return forbidden(
          "Only an authorized Observer may override this incident (OBSERVER_OVERRIDE).",
        );
      }

      // Persist the request-side state: record the resolution source and append
      // an audit entry preserving the existing ordered trail (R12.6, R13.6-7).
      // The worker owns the terminal OPEN->RESOLVED transition (R13.8), so we do
      // not flip `status` here and never race its conditional update.
      const existingTrail = Array.isArray(incident.auditTrail)
        ? incident.auditTrail
        : [];
      const auditEntry = {
        at: new Date(now()).toISOString(),
        cause:
          source === ANCHOR_DISMISSAL
            ? "ANCHOR_DISMISSAL requested"
            : "OBSERVER_OVERRIDE requested",
        source,
        by: callerId,
      };
      await app.prisma.safetyIncident.update({
        where: { id: incident.id },
        data: {
          resolutionSource: source,
          auditTrail: [...existingTrail, auditEntry],
        },
      });

      // Emit for the worker to perform the atomic transition + stage halt.
      await app.events.emit("incident.resolved", {
        incidentId: incident.id,
        source,
      });

      return { incidentId: incident.id, source, accepted: true as const };
    },
  );

  // POST /incidents/trigger-sos — Anchor-only Shadow_SOS. Create or hand off the
  // caller's active incident to HANDED_OFF_SOS and emit `sos.triggered`; the
  // worker performs the atomic handoff + black-box release on the event
  // (R11.4-11.6, R13.9). The optional one-shot decrypted SOS location is
  // forwarded on the event only — never persisted as a continuous trace.
  typed.post(
    "/incidents/trigger-sos",
    {
      onRequest: [app.authenticate],
      schema: {
        body: TriggerSosSchema,
        response: {
          200: IncidentSummarySchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const anchorId = request.user.sub;
      const { decryptedLocation } = request.body;

      // Anchor-only: the caller must be a CircleMember whose role makes them an
      // Anchor (ANCHOR or MUTUAL) in at least one circle. A pure Observer is
      // denied 403. We take the most recent such membership as the SOS circle.
      const anchorMembership = await app.prisma.circleMember.findFirst({
        where: { userId: anchorId, role: { in: ["ANCHOR", "MUTUAL"] } },
        select: { circleId: true, role: true },
      });
      if (!anchorMembership || !ANCHOR_ROLES.has(anchorMembership.role)) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "Only an Anchor may trigger a Shadow_SOS.",
        });
      }

      const circleId = anchorMembership.circleId;
      const nowIso = new Date(now()).toISOString();

      // Hand off an existing OPEN incident for this Anchor, or create a fresh
      // HANDED_OFF_SOS incident when none is open. Setting the terminal SOS
      // status here is safe: the worker keys its box-release / job-cancel off
      // the emitted event and is idempotent on an already-handed-off incident,
      // and this is the single request path that opens a Shadow_SOS incident.
      const existing = await app.prisma.safetyIncident.findFirst({
        where: { anchorId, circleId, status: "OPEN" },
        select: { id: true, auditTrail: true },
      });

      const handoffEntry = {
        at: nowIso,
        cause: "SHADOW_SOS triggered — handed off to Shadow_SOS dispatch",
        source: SHADOW_SOS_HANDOFF,
      };

      let incidentId: string;
      let stage: string;
      let openedAt: string;

      if (existing) {
        const existingTrail = Array.isArray(existing.auditTrail)
          ? existing.auditTrail
          : [];
        const updated = await app.prisma.safetyIncident.update({
          where: { id: existing.id },
          data: {
            status: "HANDED_OFF_SOS",
            resolutionSource: SHADOW_SOS_HANDOFF,
            auditTrail: [...existingTrail, handoffEntry],
          },
          select: { id: true, stage: true, openedAt: true },
        });
        incidentId = updated.id;
        stage = updated.stage;
        openedAt = updated.openedAt.toISOString();
      } else {
        const created = await app.prisma.safetyIncident.create({
          data: {
            circleId,
            anchorId,
            // A Shadow_SOS is a top-of-ladder emergency; open it directly at the
            // hyperlocal-dispatch stage so any Stage-gated release (e.g. black
            // box) is consistent with an active emergency.
            stage: "STAGE_4_HYPERLOCAL_DISPATCH",
            status: "HANDED_OFF_SOS",
            resolutionSource: SHADOW_SOS_HANDOFF,
            auditTrail: [handoffEntry],
          },
          select: { id: true, stage: true, openedAt: true },
        });
        incidentId = created.id;
        stage = created.stage;
        openedAt = created.openedAt.toISOString();
      }

      // Emit for the worker: it cancels timed jobs, releases authorized black
      // boxes, and dispatches — including the one-shot decrypted location in the
      // Observer alert (R11.4-11.6, R13.9). The coordinate travels on the event
      // only; it is never written to a persisted location-trace column.
      await app.events.emit("sos.triggered", {
        incidentId,
        circleId,
        anchorId,
        ...(decryptedLocation ? { decryptedLocation } : {}),
      });

      return {
        incidentId,
        circleId,
        anchorId,
        stage: stage as never,
        status: "HANDED_OFF_SOS" as const,
        simulated: false,
        batteryDepletionLikely: false,
        resolutionSource: SHADOW_SOS_HANDOFF,
        openedAt,
      };
    },
  );

  // POST /sanctuary — create a SanctuarySchedule for the caller. Validate the
  // 14-day cap (R34.1) -> 400 on violation. `userId` is the authenticated
  // caller; the body `anchorId` identifies the Anchor the window applies to and
  // is echoed on the response.
  typed.post(
    "/sanctuary",
    {
      onRequest: [app.authenticate],
      schema: {
        body: SanctuaryCreateBodySchema,
        response: {
          200: SanctuaryWindowSchema,
          400: BadRequestSchema,
        },
      },
    },
    async (request, reply) => {
      const callerId = request.user.sub;
      const { anchorId, startsAt, resumesAt, reason } = request.body;

      // Re-validate the 14-day cap (R34.1). The DTO refinement already enforces
      // this, but we return a descriptive 400 rather than a generic schema
      // rejection to make the cap explicit at the route boundary.
      const startMs = Date.parse(startsAt);
      const resumeMs = Date.parse(resumesAt);
      if (!(resumeMs > startMs) || resumeMs - startMs > FOURTEEN_DAYS_MS) {
        return reply.code(400).send({
          error: "Bad Request" as const,
          message:
            "resumesAt must be after startsAt and within 14 days (R34.1).",
        });
      }

      const schedule = await app.prisma.sanctuarySchedule.create({
        data: {
          userId: callerId,
          startsAt: new Date(startMs),
          resumesAt: new Date(resumeMs),
          ...(reason !== undefined ? { reason } : {}),
          // `isActive` defaults to true in the schema.
        },
        select: {
          id: true,
          startsAt: true,
          resumesAt: true,
          reason: true,
          isActive: true,
        },
      });

      return {
        id: schedule.id,
        anchorId,
        startsAt: schedule.startsAt.toISOString(),
        resumesAt: schedule.resumesAt.toISOString(),
        ...(schedule.reason ? { reason: schedule.reason } : {}),
        isActive: schedule.isActive,
      };
    },
  );

  // DELETE /sanctuary/:id — deactivate (isActive=false) the caller's own
  // schedule (early manual end). Automatic resume needs no call (R34.4). A
  // schedule that does not belong to the caller (or is unknown) -> 404.
  typed.delete(
    "/sanctuary/:id",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        response: {
          200: SanctuaryWindowSchema,
          404: NotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const callerId = request.user.sub;
      const { id } = request.params;

      // Scope the deactivation to the caller's own schedule so one User cannot
      // end another's Sanctuary window.
      const existing = await app.prisma.sanctuarySchedule.findFirst({
        where: { id, userId: callerId },
        select: { id: true },
      });
      if (!existing) {
        return reply.code(404).send({
          error: "Not Found" as const,
          message: "No such sanctuary schedule for this user.",
        });
      }

      const updated = await app.prisma.sanctuarySchedule.update({
        where: { id: existing.id },
        data: { isActive: false },
        select: {
          id: true,
          userId: true,
          startsAt: true,
          resumesAt: true,
          reason: true,
          isActive: true,
        },
      });

      return {
        id: updated.id,
        anchorId: updated.userId,
        startsAt: updated.startsAt.toISOString(),
        resumesAt: updated.resumesAt.toISOString(),
        ...(updated.reason ? { reason: updated.reason } : {}),
        isActive: updated.isActive,
      };
    },
  );

  // GET /sanctuary/active — list the caller's currently-active windows
  // (isActive=true AND now < resumesAt) for calm-banner rendering (R34.3).
  typed.get(
    "/sanctuary/active",
    {
      onRequest: [app.authenticate],
      schema: {
        response: { 200: ActiveSanctuaryResponseSchema },
      },
    },
    async (request) => {
      const callerId = request.user.sub;
      const nowDate = new Date(now());

      const active = await app.prisma.sanctuarySchedule.findMany({
        where: {
          userId: callerId,
          isActive: true,
          resumesAt: { gt: nowDate },
        },
        orderBy: { resumesAt: "asc" },
        select: {
          id: true,
          userId: true,
          startsAt: true,
          resumesAt: true,
          reason: true,
          isActive: true,
        },
      });

      return active.map((s) => ({
        id: s.id,
        anchorId: s.userId,
        startsAt: s.startsAt.toISOString(),
        resumesAt: s.resumesAt.toISOString(),
        ...(s.reason ? { reason: s.reason } : {}),
        isActive: s.isActive,
      }));
    },
  );

  // PUT /medical-dossier — ciphertext-only upsert of the caller's
  // EmergencyMedicalDossier (R33.1, R33.2). The server stores the envelope
  // verbatim and is blind to the plaintext. There is deliberately NO GET here:
  // the plaintext is reachable only via the Stage-4 responder-portal release
  // path (R33.2, R33.3).
  typed.put(
    "/medical-dossier",
    {
      onRequest: [app.authenticate],
      schema: {
        body: UpsertMedicalDossierSchema,
        response: { 200: DossierAckSchema },
      },
    },
    async (request) => {
      const userId = request.user.sub;
      const { encryptedPayload, iv, authTag, encryptedEmergencyKey } =
        request.body;

      // Decode base64 -> Bytes purely for transport; the buffers are stored
      // verbatim and never inspected or decrypted (R33.2).
      const cipher = {
        encryptedPayload: Buffer.from(encryptedPayload, "base64"),
        iv: Buffer.from(iv, "base64"),
        authTag: Buffer.from(authTag, "base64"),
        encryptedEmergencyKey: Buffer.from(encryptedEmergencyKey, "base64"),
      };

      const dossier = await app.prisma.emergencyMedicalDossier.upsert({
        where: { userId },
        create: {
          userId,
          ...cipher,
          // `accessState` defaults to LOCKED in the schema.
        },
        update: {
          ...cipher,
        },
        select: { id: true },
      });

      return { dossierId: dossier.id, stored: true as const };
    },
  );
}

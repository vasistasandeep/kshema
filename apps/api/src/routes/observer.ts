/**
 * Mobile Observer dashboard route (task 21.1 — R15.1-R15.5).
 *
 * Mounted under `/api/v1`, so the effective path is:
 *   - `GET /api/v1/observer/dashboard`   calm per-Anchor well-being list
 *
 * Requires a valid bearer token (`app.authenticate`); an anonymous caller is
 * rejected `401` by the guard.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS RETURNS. For the calling Observer, one `AnchorWellBeing` entry per
 * Anchor they observe across every Circle in which they hold an Observer-side
 * role (OBSERVER or MUTUAL). Each entry carries a DERIVED well-being state, the
 * Anchor's preferred display name, and the last confirmation time. It carries
 * NO continuous location trace — the `ObserverDashboardSchema` / `.strict()`
 * DTO in `@kshema/types` structurally forbids any location field (R15.5,
 * R19.1), and this handler never selects or emits one.
 *
 * DERIVED STATE (R15.1-R15.3). The state is computed, never stored, in strict
 * precedence:
 *   1. SHIELD_PAUSED — when the Anchor's Circle Subscription tier is
 *      SHIELD_PAUSED, safety automation is suspended, so the dashboard shows a
 *      neutral "Shield Paused" disclosure regardless of any other signal
 *      (R20.2, surfaced calmly per the Brand_Lexicon).
 *   2. ESCALATING + `escalationStage` — else, when the Anchor has an OPEN
 *      SafetyIncident in that Circle, the dashboard surfaces the current
 *      Escalation_Stage (R15.3).
 *   3. ALL_WELL — else the Anchor is calm and confirmed (R15.2, rendered in
 *      Muted Sage Green by the client).
 * The tri-valued `WellBeingStateSchema` (ALL_WELL | SHIELD_PAUSED | ESCALATING)
 * plus the optional `escalationStage` encode exactly these Brand_Lexicon
 * states; the route invents no Banned_Terms.
 *
 * LAST CONFIRMATION TIME (R15.2). The most recent positive confirmation for the
 * Anchor: the newest `VitalityPulseLog.confirmedAt` (a verified morning
 * routine) OR the newest confirming `TelemetryLog` — a heartbeat that itself
 * evidences life (a screen unlock or a positive step delta). We take the later
 * of the two. It is omitted when the Anchor has no confirmation on record.
 *
 * ANCHOR SET. The caller observes an Anchor when they share a Circle and the
 * other member holds an Anchor-side role (ANCHOR or MUTUAL). A Mutual caller is
 * both Anchor and Observer, so we simply exclude the caller's own membership
 * row from the Anchor list. The same underlying User seen across multiple
 * Circles is de-duplicated by `anchorId`, keeping the worst (least-well) state
 * so the Observer is never falsely reassured.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ObserverDashboardSchema,
  type AnchorWellBeing,
  type WellBeingState,
  type IncidentStage,
} from "@kshema/types";

/** Circle roles that make the CALLER an Observer of the Circle's Anchors. */
const OBSERVER_ROLES = ["OBSERVER", "MUTUAL"] as const;

/** Circle roles that make a co-member an ANCHOR the caller observes. */
const ANCHOR_ROLES = ["ANCHOR", "MUTUAL"] as const;

/**
 * Well-being ordering used to de-dup an Anchor seen in several Circles: the
 * least-well state wins so the Observer is never falsely reassured. Higher rank
 * = more concerning.
 */
const STATE_RANK: Record<WellBeingState, number> = {
  ALL_WELL: 0,
  SHIELD_PAUSED: 1,
  ESCALATING: 2,
};

export async function observerRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET /observer/dashboard — calm per-Anchor well-being list for the caller.
  typed.get(
    "/observer/dashboard",
    {
      onRequest: [app.authenticate],
      schema: {
        response: { 200: ObserverDashboardSchema },
      },
    },
    async (request) => {
      const observerId = request.user.sub;

      // The Circles in which the caller holds an Observer-side role.
      const observerMemberships = await app.prisma.circleMember.findMany({
        where: { userId: observerId, role: { in: [...OBSERVER_ROLES] } },
        select: { circleId: true },
      });
      const circleIds = observerMemberships.map((m) => m.circleId);
      if (circleIds.length === 0) {
        return { anchors: [] };
      }

      // Every Anchor-role member of those Circles, excluding the caller's own
      // membership row (a Mutual caller does not observe themselves).
      const anchorMembers = await app.prisma.circleMember.findMany({
        where: {
          circleId: { in: circleIds },
          role: { in: [...ANCHOR_ROLES] },
          userId: { not: observerId },
        },
        select: { circleId: true, userId: true },
      });
      if (anchorMembers.length === 0) {
        return { anchors: [] };
      }

      // Circle-level subscription tiers (SHIELD_PAUSED gate, R20.2).
      const subscriptions = await app.prisma.subscription.findMany({
        where: { circleId: { in: circleIds } },
        select: { circleId: true, tier: true },
      });
      const tierByCircle = new Map(
        subscriptions.map((s) => [s.circleId, s.tier]),
      );

      // Resolve each distinct (circle, anchor) pair into a derived entry, then
      // de-dup by anchorId keeping the least-well state.
      const byAnchor = new Map<string, AnchorWellBeing>();

      for (const member of anchorMembers) {
        const { circleId, userId: anchorId } = member;

        // Preferred display name (R15.2). Fall back to a neutral, non-Banned
        // label when the Anchor has not set one, never a clinical term.
        const user = await app.prisma.user.findUnique({
          where: { id: anchorId },
          select: { preferredName: true },
        });
        const preferredName =
          user?.preferredName && user.preferredName.trim().length > 0
            ? user.preferredName
            : "Anchor";

        // Derive the state in precedence order.
        let state: WellBeingState;
        let escalationStage: IncidentStage | undefined;

        if (tierByCircle.get(circleId) === "SHIELD_PAUSED") {
          state = "SHIELD_PAUSED";
        } else {
          const openIncident = await app.prisma.safetyIncident.findFirst({
            where: { circleId, anchorId, status: "OPEN" },
            orderBy: { openedAt: "desc" },
            select: { stage: true },
          });
          if (openIncident) {
            state = "ESCALATING";
            escalationStage = openIncident.stage as IncidentStage;
          } else {
            state = "ALL_WELL";
          }
        }

        // Last confirmation time: the later of the newest Vitality_Pulse and
        // the newest confirming heartbeat (screen unlock or positive steps).
        const lastConfirmationAt = await lastConfirmation(app, anchorId);

        const entry: AnchorWellBeing = {
          anchorId,
          preferredName,
          state,
          ...(escalationStage ? { escalationStage } : {}),
          ...(lastConfirmationAt ? { lastConfirmationAt } : {}),
        };

        const existing = byAnchor.get(anchorId);
        if (!existing) {
          byAnchor.set(anchorId, entry);
          continue;
        }
        // Keep the least-well (highest-rank) state; on a tie keep the later
        // confirmation time so the freshest signal wins.
        const better =
          STATE_RANK[entry.state] > STATE_RANK[existing.state]
            ? entry
            : STATE_RANK[entry.state] < STATE_RANK[existing.state]
              ? existing
              : mergeConfirmation(existing, entry);
        byAnchor.set(anchorId, better);
      }

      return { anchors: [...byAnchor.values()] };
    },
  );
}

/**
 * Newest positive confirmation for an Anchor, as an ISO-8601 string, or
 * `undefined` when none is on record. Considers the newest `VitalityPulseLog`
 * and the newest confirming `TelemetryLog` (a screen unlock or a positive step
 * delta) and returns whichever is later (R15.2).
 */
async function lastConfirmation(
  app: FastifyInstance,
  anchorId: string,
): Promise<string | undefined> {
  const [pulse, heartbeat] = await Promise.all([
    app.prisma.vitalityPulseLog.findFirst({
      where: { anchorId },
      orderBy: { confirmedAt: "desc" },
      select: { confirmedAt: true },
    }),
    app.prisma.telemetryLog.findFirst({
      where: {
        userId: anchorId,
        OR: [{ screenUnlock: true }, { stepDelta: { gt: 0 } }],
      },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    }),
  ]);

  const candidates: Date[] = [];
  if (pulse?.confirmedAt) candidates.push(pulse.confirmedAt);
  if (heartbeat?.receivedAt) candidates.push(heartbeat.receivedAt);
  if (candidates.length === 0) return undefined;

  const latest = candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  return latest.toISOString();
}

/**
 * Merge two entries for the same Anchor and equal state, preferring the later
 * `lastConfirmationAt` so the freshest confirmation is surfaced.
 */
function mergeConfirmation(
  a: AnchorWellBeing,
  b: AnchorWellBeing,
): AnchorWellBeing {
  const aMs = a.lastConfirmationAt ? Date.parse(a.lastConfirmationAt) : -Infinity;
  const bMs = b.lastConfirmationAt ? Date.parse(b.lastConfirmationAt) : -Infinity;
  return bMs > aMs ? b : a;
}

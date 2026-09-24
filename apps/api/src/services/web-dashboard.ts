/**
 * Web Observer dashboard derivation (task 20.2 — R28.5-R28.9).
 *
 * A single pure-ish resolver, `buildDashboardSnapshot`, that computes the
 * per-Anchor well-being snapshot the Ambient Desk Mode renders. It is reused by
 * BOTH the SSE stream (`GET /web/dashboard/stream`) and the WebSocket-fallback
 * snapshot endpoint (`GET /web/dashboard/ws`), so the two transports never
 * diverge — the frame shape is identical (R28.5, R28.9).
 *
 * The derivation mirrors the mobile Observer dashboard (`routes/observer.ts`,
 * R15) so the web and mobile surfaces agree on well-being state:
 *   1. SHIELD_PAUSED  — the Anchor's Circle Subscription tier is SHIELD_PAUSED
 *      (safety automation suspended), shown calmly regardless of any other
 *      signal (R20.2).
 *   2. ESCALATING + `escalationStage` — else, an OPEN SafetyIncident surfaces
 *      the current Escalation_Stage so Ambient Desk Mode can shift to Soft
 *      Amber and expose the voice-call / mark-safe controls (R28.8).
 *   3. ALL_WELL — else the Anchor is calm; the hero card renders in Muted Sage
 *      Green with the verified morning wakefulness timestamp (R28.7).
 *
 * DUAL-TIMEZONE TICK (R28.6). Each entry carries `observerTime` (the emission
 * instant) and `anchorTime` (the same instant expressed in the Anchor's IANA
 * timezone) plus the `anchorTimezone` id, so the client can render the
 * synchronized dual-timezone clock without additional round-trips.
 *
 * NO LOCATION TRACE (R28.15). No location field is ever selected or emitted;
 * the `DashboardTick` / `DashboardSnapshot` DTOs additionally forbid one
 * structurally.
 */
import type { FastifyInstance } from "fastify";
import type {
  DashboardSnapshot,
  DashboardTick,
  IncidentStage,
  WellBeingState,
} from "@kshema/types";

/** Circle roles that make the CALLER an Observer of the Circle's Anchors. */
const OBSERVER_ROLES = ["OBSERVER", "MUTUAL"] as const;

/** Circle roles that make a co-member an ANCHOR the caller observes. */
const ANCHOR_ROLES = ["ANCHOR", "MUTUAL"] as const;

/**
 * Least-well-wins ordering when the same Anchor is seen across several Circles,
 * so the Observer is never falsely reassured. Higher = more concerning.
 */
const STATE_RANK: Record<WellBeingState, number> = {
  ALL_WELL: 0,
  SHIELD_PAUSED: 1,
  ESCALATING: 2,
};

/**
 * Render `instant` as an ISO-8601 string carrying the wall-clock offset for the
 * IANA `timezone` (e.g. `2024-03-15T08:00:00.000+05:30`). Falls back to the
 * plain UTC ISO string if the timezone is unknown/unparseable so a bad profile
 * value never breaks the stream (the tick still renders).
 */
export function isoInTimezone(instant: Date, timezone: string): string {
  try {
    // Intl gives us the wall-clock parts in `timezone`; we then compute the
    // offset from UTC and format an ISO string with that offset.
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    let hour = get("hour");
    if (hour === "24") hour = "00";
    const wall = Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(hour),
      Number(get("minute")),
      Number(get("second")),
    );
    // Offset (minutes) = local wall clock minus true UTC instant.
    const offsetMin = Math.round((wall - instant.getTime()) / 60000);
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, "0");
    const om = String(abs % 60).padStart(2, "0");
    const ms = String(instant.getMilliseconds()).padStart(3, "0");
    return (
      `${get("year")}-${get("month")}-${get("day")}` +
      `T${hour.padStart(2, "0")}:${get("minute")}:${get("second")}.${ms}` +
      `${sign}${oh}:${om}`
    );
  } catch {
    return instant.toISOString();
  }
}

/**
 * The most recent positive confirmation for an Anchor (R28.7 "verified morning
 * wakefulness timestamp"): the later of the newest `VitalityPulseLog` and the
 * newest confirming `TelemetryLog` (a screen unlock or positive step delta).
 */
async function lastConfirmation(
  app: FastifyInstance,
  anchorId: string,
): Promise<Date | undefined> {
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
  return candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/**
 * Compute the dashboard snapshot for `observerId` at the instant `now`. Returns
 * one `DashboardTick` per distinct Anchor the Observer watches, de-duplicated
 * by `anchorId` keeping the least-well state, plus the emission `observerTime`.
 */
export async function buildDashboardSnapshot(
  app: FastifyInstance,
  observerId: string,
  now: Date,
): Promise<DashboardSnapshot> {
  const observerTime = now.toISOString();

  // Circles the caller observes.
  const observerMemberships = await app.prisma.circleMember.findMany({
    where: { userId: observerId, role: { in: [...OBSERVER_ROLES] } },
    select: { circleId: true },
  });
  const circleIds = observerMemberships.map((m) => m.circleId);
  if (circleIds.length === 0) {
    return { observerTime, anchors: [] };
  }

  // Anchor-role co-members (excluding the caller themselves).
  const anchorMembers = await app.prisma.circleMember.findMany({
    where: {
      circleId: { in: circleIds },
      role: { in: [...ANCHOR_ROLES] },
      userId: { not: observerId },
    },
    select: { circleId: true, userId: true },
  });
  if (anchorMembers.length === 0) {
    return { observerTime, anchors: [] };
  }

  // Circle subscription tiers (SHIELD_PAUSED gate).
  const subscriptions = await app.prisma.subscription.findMany({
    where: { circleId: { in: circleIds } },
    select: { circleId: true, tier: true },
  });
  const tierByCircle = new Map(subscriptions.map((s) => [s.circleId, s.tier]));

  const byAnchor = new Map<string, DashboardTick>();

  for (const member of anchorMembers) {
    const { circleId, userId: anchorId } = member;

    const user = await app.prisma.user.findUnique({
      where: { id: anchorId },
      select: { preferredName: true, timezone: true },
    });
    const preferredName =
      user?.preferredName && user.preferredName.trim().length > 0
        ? user.preferredName
        : "Anchor";
    const anchorTimezone = user?.timezone ?? "Asia/Kolkata";

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

    const confirmedAt = await lastConfirmation(app, anchorId);

    const entry: DashboardTick = {
      anchorId,
      preferredName,
      state,
      ...(escalationStage ? { escalationStage } : {}),
      ...(confirmedAt ? { lastConfirmationAt: confirmedAt.toISOString() } : {}),
      observerTime,
      anchorTime: isoInTimezone(now, anchorTimezone),
      anchorTimezone,
    };

    const existing = byAnchor.get(anchorId);
    if (!existing) {
      byAnchor.set(anchorId, entry);
      continue;
    }
    const better =
      STATE_RANK[entry.state] > STATE_RANK[existing.state]
        ? entry
        : STATE_RANK[entry.state] < STATE_RANK[existing.state]
          ? existing
          : mergeConfirmation(existing, entry);
    byAnchor.set(anchorId, better);
  }

  return { observerTime, anchors: [...byAnchor.values()] };
}

/** Prefer the entry with the later `lastConfirmationAt` on an equal state. */
function mergeConfirmation(a: DashboardTick, b: DashboardTick): DashboardTick {
  const aMs = a.lastConfirmationAt ? Date.parse(a.lastConfirmationAt) : -Infinity;
  const bMs = b.lastConfirmationAt ? Date.parse(b.lastConfirmationAt) : -Infinity;
  return bMs > aMs ? b : a;
}

/**
 * Presentation helpers for Ambient Desk Mode (R28.6, R28.7, R28.8, R28.18).
 *
 * Pure functions mapping a `DashboardTick` to brand-locked colors and
 * Brand_Lexicon copy, plus the dual-timezone clock formatter. Kept free of
 * React so the palette rules and the "All Well" / escalation labelling are
 * unit-testable. All user-facing strings are drawn from the Brand_Lexicon and
 * exclude every Banned_Term (Monitoring, Surveillance, Tracking, Patient,
 * Elderly Watch, Supervision, Fall Alarm, Panic Button).
 */
import type { DashboardTick, IncidentStage, WellBeingState } from "@kshema/types";
import { palette } from "@kshema/ui";

/** Hero card presentation for one Anchor. */
export interface HeroPresentation {
  /** Tailwind background class from the shared preset. */
  readonly bgClass: string;
  /** Raw hex (for inline canvas tint) mirroring the Tailwind class. */
  readonly hex: string;
  /** Brand_Lexicon status label. */
  readonly label: string;
  /** Whether direct-action controls (voice call + mark safe) should show. */
  readonly showActions: boolean;
}

const STAGE_LABEL: Record<IncidentStage, string> = {
  STAGE_1_CONVERSATIONAL_WHATSAPP: "Reaching out — Stage 1",
  STAGE_2_GENTLE_DEVICE_CHIME: "Gentle chime — Stage 2",
  STAGE_3_OBSERVER_SILENT_ALERT: "Quiet alert — Stage 3",
  STAGE_4_HYPERLOCAL_DISPATCH: "Nearby help on the way — Stage 4",
};

/**
 * Map a well-being state to its hero presentation. Healthy → Muted Sage Green
 * "All Well" (R28.7); escalating → Soft Amber with the active stage and
 * direct-action controls (R28.8); paused → neutral Temple Brass Ambient Shield
 * disclosure. Clinical red / hospital blue never appear (R16.4).
 */
export function heroFor(tick: DashboardTick): HeroPresentation {
  const state: WellBeingState = tick.state;
  if (state === "ESCALATING") {
    const label = tick.escalationStage
      ? STAGE_LABEL[tick.escalationStage]
      : "Checking in";
    return {
      bgClass: "bg-escalating",
      hex: palette.softAmber,
      label,
      showActions: true,
    };
  }
  if (state === "SHIELD_PAUSED") {
    return {
      bgClass: "bg-celebration",
      hex: palette.templeBrass,
      label: "Ambient Shield paused",
      showActions: false,
    };
  }
  return {
    bgClass: "bg-healthy",
    hex: palette.mutedSageGreen,
    label: "All Well",
    showActions: false,
  };
}

/** A dual-timezone clock reading contrasting Observer and Anchor local time. */
export interface DualClock {
  readonly observerLabel: string;
  readonly anchorLabel: string;
  readonly anchorTimezone: string;
}

/**
 * Format the dual-timezone clock (R28.6). `observerTz` defaults to the
 * browser's resolved timezone; the Anchor time is rendered in the Anchor's
 * IANA zone carried on the tick.
 */
export function formatDualClock(
  tick: DashboardTick,
  observerTz?: string,
): DualClock {
  const observerZone =
    observerTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    observerLabel: formatInZone(tick.observerTime, observerZone),
    anchorLabel: formatInZone(tick.anchorTime, tick.anchorTimezone),
    anchorTimezone: tick.anchorTimezone,
  };
}

function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      weekday: "short",
    }).format(new Date(iso));
  } catch {
    // An unknown IANA zone falls back to a plain UTC reading rather than throw.
    return new Date(iso).toUTCString();
  }
}

/** Human-friendly "last confirmed" line for the hero card. */
export function lastConfirmedLabel(tick: DashboardTick): string | undefined {
  if (!tick.lastConfirmationAt) return undefined;
  const when = formatInZone(tick.lastConfirmationAt, tick.anchorTimezone);
  return `Verified morning wakefulness ${when}`;
}

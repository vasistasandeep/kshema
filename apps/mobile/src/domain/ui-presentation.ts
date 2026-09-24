/**
 * UI presentation logic for the Observer and Anchor surfaces (task 23.1).
 *
 * This module holds the *framework-agnostic* presentation decisions behind the
 * Observer dashboard and the Anchor sanctuary home so they can be typechecked
 * and unit-tested under Node in CI (`tsconfig.domain.json` / vitest), while the
 * `.tsx` surfaces stay thin and consume these helpers. The React Native layer
 * (`app/(app)/observer.tsx`, `app/(app)/anchor.tsx`) is typechecked separately
 * via the Expo toolchain (`typecheck:app`) and built by EAS.
 *
 * Everything user-facing here is drawn from the Brand_Lexicon and excludes
 * every Banned_Term (R15.4, R16.5, R22.19, R22.20). Colors reference the shared
 * `@kshema/ui` semantic tokens only, so clinical red / hospital blue can never
 * appear (R16.4/R16.5). Nothing in this module drives escalation or alarms
 * (R22.20).
 *
 * Requirements: 7.3, 7.6, 12.7, 15.2, 15.3, 15.4, 16.5, 20.6, 20.7, 20.11,
 * 22.15, 22.16, 22.17, 22.19, 22.20, 34.3.
 */
import { semanticColors } from "@kshema/ui";
import type {
  AnchorWellBeing,
  IncidentStage,
  SparshType,
  VitalityPulse,
  PanchangaCard,
  WellBeingState,
} from "@kshema/types";
import { findBannedTerms } from "./disclaimer.js";

/**
 * Neutral grey used *only* for the Shield Paused indicator (R20.6). It is a
 * deliberately calm, non-brand grey — never "All Well" Sage and never an alarm
 * color. Kept local (not a brand token) so it stays scoped to this one state.
 */
export const SHIELD_PAUSED_GREY = "#8A8F8B" as const;

// ---------------------------------------------------------------------------
// Brand_Lexicon copy (R15.4, R16.5, R20.11). One approved string per concept;
// the i18n catalogs (task 23.2) key off these same concepts across locales.
// ---------------------------------------------------------------------------

/**
 * Approved user-facing strings. Intentionally warm and reassuring; none is a
 * Banned_Term and none is alarm/countdown phrasing (R22.20).
 */
export const BRAND_LEXICON = {
  observerTitle: "Your Circle",
  observerEmpty: "No Anchors yet. Invite someone you care for to get started.",
  stateAllWell: "All well",
  stateCheckingIn: "Checking in",
  stateShieldPaused: "Shield paused",
  shieldPausedDisclosure:
    "Automated routine check-ins and emergency dispatch are resting. You can still see the most recent battery and step signals.",
  anchorGreeting: "Good day",
  vitalityPulseHeading: "Today's Vitality Pulse",
  sparshHeading: "A little warmth from your Circle",
  sparshReply: "Send a blessing back",
  panchangaHeading: "Today's Panchanga",
  movementHeading: "Family Movement journey",
  sanctuaryBanner: "Sanctuary Shield is active",
} as const;

/**
 * Returns `true` if `text` contains any Banned_Term (R16.5, R15.4, R22.19).
 * Reuses the single Banned_Term list + guard defined alongside the
 * Safety_Disclaimer (`disclaimer.ts`) so there is one source of truth for the
 * glossary. Used by tests to assert the presentation copy stays inside the
 * Brand_Lexicon.
 */
export function containsBannedTerm(text: string): boolean {
  return findBannedTerms(text).length > 0;
}

// ---------------------------------------------------------------------------
// Observer dashboard (R12.7, R15.2, R15.3, R15.4, R20.6, R20.7).
// ---------------------------------------------------------------------------

/** How the dashboard should render one Anchor's well-being. */
export interface AnchorDashboardView {
  readonly anchorId: string;
  readonly preferredName: string;
  readonly state: WellBeingState;
  /** Dot / accent color for the state (brand semantic token or paused grey). */
  readonly color: string;
  /** Brand_Lexicon label for the state. */
  readonly label: string;
  /** Current escalation stage label, present only while ESCALATING (R15.3). */
  readonly stageLabel?: string;
  /** Shield Paused disclosure, present only while SHIELD_PAUSED (R20.7). */
  readonly disclosure?: string;
}

/**
 * Color for a well-being state:
 *   - ALL_WELL      → Muted Sage Green (R15.2, R7.6),
 *   - ESCALATING    → Soft Amber (R12.7),
 *   - SHIELD_PAUSED → neutral grey (R20.6).
 * Never clinical red / hospital blue (R16.5) — the healthy/escalating values
 * come from the shared semantic tokens, and paused is the scoped calm grey.
 */
export function wellBeingColor(state: WellBeingState): string {
  switch (state) {
    case "ALL_WELL":
      return semanticColors.healthy;
    case "ESCALATING":
      return semanticColors.escalating;
    case "SHIELD_PAUSED":
      return SHIELD_PAUSED_GREY;
    default: {
      const never: never = state;
      throw new Error(`Unhandled WellBeingState: ${String(never)}`);
    }
  }
}

/** Brand_Lexicon label for a well-being state (R15.4, R20.6). */
export function wellBeingLabel(state: WellBeingState): string {
  switch (state) {
    case "ALL_WELL":
      return BRAND_LEXICON.stateAllWell;
    case "ESCALATING":
      return BRAND_LEXICON.stateCheckingIn;
    case "SHIELD_PAUSED":
      return BRAND_LEXICON.stateShieldPaused;
    default: {
      const never: never = state;
      throw new Error(`Unhandled WellBeingState: ${String(never)}`);
    }
  }
}

/**
 * A calm, non-alarm label for an escalation stage shown on the dashboard
 * (R15.3). Deliberately reassuring wording — no countdowns, no "alert"/"alarm"
 * (R22.20). Stages 1–2 read as a gentle check-in; 3–4 as the Circle stepping in.
 */
export function escalationStageLabel(stage: IncidentStage): string {
  switch (stage) {
    case "STAGE_1_CONVERSATIONAL_WHATSAPP":
      return "Sending a gentle check-in";
    case "STAGE_2_GENTLE_DEVICE_CHIME":
      return "A soft chime on the phone";
    case "STAGE_3_OBSERVER_SILENT_ALERT":
      return "Letting the Circle know";
    case "STAGE_4_HYPERLOCAL_DISPATCH":
      return "Reaching out to people nearby";
    default: {
      const never: never = stage;
      throw new Error(`Unhandled IncidentStage: ${String(never)}`);
    }
  }
}

/**
 * Build the full dashboard view for one Anchor (R15.2–R15.4, R20.6, R20.7).
 * The disclosure appears only for SHIELD_PAUSED (R20.7); the stage label only
 * while ESCALATING (R15.3). By construction this carries no location trace —
 * the input `AnchorWellBeing` schema forbids location fields (R15.5).
 */
export function toAnchorDashboardView(anchor: AnchorWellBeing): AnchorDashboardView {
  const base: AnchorDashboardView = {
    anchorId: anchor.anchorId,
    preferredName: anchor.preferredName,
    state: anchor.state,
    color: wellBeingColor(anchor.state),
    label: wellBeingLabel(anchor.state),
  };

  if (anchor.state === "ESCALATING" && anchor.escalationStage) {
    return { ...base, stageLabel: escalationStageLabel(anchor.escalationStage) };
  }
  if (anchor.state === "SHIELD_PAUSED") {
    return { ...base, disclosure: BRAND_LEXICON.shieldPausedDisclosure };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Vitality Pulse card (R7.3, R7.6).
// ---------------------------------------------------------------------------

/** Presentation model for the Anchor's Vitality Pulse card. */
export interface VitalityPulseCardView {
  readonly heading: string;
  readonly preferredName: string;
  /** Confirmation time in the Anchor timezone, formatted upstream. */
  readonly confirmedAt: string;
  readonly stepContext?: number;
  readonly weatherContext?: string;
  /** Always the healthy Sage token — the Vitality Pulse healthy color (R7.6). */
  readonly color: string;
}

/**
 * Map a {@link VitalityPulse} DTO onto its card view. Presented in the
 * healthy-state Muted Sage Green (R7.6) and worded from the Brand_Lexicon
 * (R7.3). Optional step/weather context is passed through only when present.
 */
export function toVitalityPulseCard(pulse: VitalityPulse): VitalityPulseCardView {
  return {
    heading: BRAND_LEXICON.vitalityPulseHeading,
    preferredName: pulse.preferredName,
    confirmedAt: pulse.confirmedAt,
    stepContext: pulse.stepContext,
    weatherContext: pulse.weatherContext,
    color: semanticColors.healthy,
  };
}

// ---------------------------------------------------------------------------
// Sparsh widget + one-tap blessing/heart response (R22.15-adjacent: R22.8, R22.10).
// ---------------------------------------------------------------------------

/** A single one-tap Sparsh option with its Brand_Lexicon label + glyph. */
export interface SparshOption {
  readonly type: SparshType;
  readonly label: string;
  readonly glyph: string;
}

/**
 * The four one-tap Sparsh_Reaction options presented on the morning widget
 * (R22.8): Morning Chai, Pranam/Blessing, Morning Sun, Marigold Flower. The
 * fifth enum value (`HEART_BLESSING`) is reserved for the Anchor's one-tap
 * reply and is intentionally excluded here.
 */
export const SPARSH_OPTIONS: readonly SparshOption[] = [
  { type: "MORNING_CHAI", label: "Morning Chai", glyph: "☕" },
  { type: "PRANAM_BLESSING", label: "Pranam", glyph: "🙏" },
  { type: "MORNING_SUN", label: "Morning Sun", glyph: "🌅" },
  { type: "MARIGOLD_FLOWER", label: "Marigold", glyph: "🌼" },
];

/**
 * The Anchor's one-tap reply options — a blessing or a heart, requiring no
 * typing (R22.10).
 */
export const SPARSH_REPLY_OPTIONS: readonly SparshOption[] = [
  { type: "PRANAM_BLESSING", label: "Blessing", glyph: "🙏" },
  { type: "HEART_BLESSING", label: "Heart", glyph: "❤️" },
];

// ---------------------------------------------------------------------------
// Daily Panchanga card refresh at 04:00 Anchor-local (R22.16 → R22.14).
// ---------------------------------------------------------------------------

/**
 * Given the current Anchor-local wall-clock hour (0–23) and the date shown on
 * the card, decide whether the Daily_Panchanga_Card should refresh to a new
 * day. The card advances once the local clock reaches 04:00 (R22.14): before
 * 04:00 it still shows "yesterday"; at/after 04:00 it shows today.
 *
 * Returns the yyyy-mm-dd the card *should* display for the given local time, so
 * the surface can compare against what it currently renders and refetch when
 * they differ. Pure over `(localHour, todayYmd, yesterdayYmd)`.
 */
export function panchangaCardDateFor(
  localHour: number,
  todayYmd: string,
  yesterdayYmd: string,
): string {
  return localHour >= PANCHANGA_REFRESH_HOUR ? todayYmd : yesterdayYmd;
}

/** The Anchor-local hour at which the Panchanga card rolls to the new day. */
export const PANCHANGA_REFRESH_HOUR = 4 as const;

/**
 * Whether a card currently showing `displayedDate` is stale for the given local
 * time and should refresh (R22.14). True iff the target date differs from what
 * is displayed.
 */
export function panchangaNeedsRefresh(
  localHour: number,
  displayedDate: string,
  todayYmd: string,
  yesterdayYmd: string,
): boolean {
  return panchangaCardDateFor(localHour, todayYmd, yesterdayYmd) !== displayedDate;
}

/** Presentation model for the Daily Panchanga card. */
export interface PanchangaCardView {
  readonly heading: string;
  readonly card: PanchangaCard;
}

/** Wrap a {@link PanchangaCard} DTO with its Brand_Lexicon heading (R22.12). */
export function toPanchangaCardView(card: PanchangaCard): PanchangaCardView {
  return { heading: BRAND_LEXICON.panchangaHeading, card };
}

// ---------------------------------------------------------------------------
// Family Movement Milestone journey (R22.15, R22.16, R22.17).
// ---------------------------------------------------------------------------

/** One Circle member's weekly step contribution to the shared journey. */
export interface MemberSteps {
  readonly userId: string;
  readonly preferredName: string;
  readonly weeklySteps: number;
}

/**
 * Cooperative, non-competitive journey view (R22.15, R22.17). It exposes the
 * Circle's *combined* weekly steps and progress toward the next milestone —
 * and deliberately never ranks members or shows per-member leaderboards
 * (R22.17). The postcard flag turns on when a milestone is reached (R22.16).
 */
export interface MovementJourneyView {
  readonly heading: string;
  /** Combined weekly steps across the whole Circle (R22.15). */
  readonly totalSteps: number;
  /** The milestone step target currently being worked toward. */
  readonly milestoneTarget: number;
  /** Progress toward the current milestone, clamped to [0, 1]. */
  readonly progress: number;
  /** True when the milestone has been reached — show the postcard (R22.16). */
  readonly milestoneReached: boolean;
  /** Number of members contributing (count only — never a ranking, R22.17). */
  readonly contributorCount: number;
  /** Celebration accent used only when a milestone is reached (R22.19). */
  readonly celebrationColor: string;
}

/**
 * Default weekly milestone target (steps) for the shared journey. A gentle,
 * cooperative goal — not a competitive quota.
 */
export const DEFAULT_MOVEMENT_MILESTONE = 70_000 as const;

/**
 * Aggregate Circle members' weekly steps into the cooperative journey view
 * (R22.15). Sums every member's steps, computes progress toward
 * `milestoneTarget`, and flags the postcard when the target is met (R22.16).
 * Produces no per-member ordering or ranking (R22.17) — only the total and a
 * contributor count. Pure and order-independent over the input array.
 */
export function buildMovementJourney(
  members: readonly MemberSteps[],
  milestoneTarget: number = DEFAULT_MOVEMENT_MILESTONE,
): MovementJourneyView {
  const target = milestoneTarget > 0 ? milestoneTarget : DEFAULT_MOVEMENT_MILESTONE;
  const totalSteps = members.reduce((sum, m) => sum + Math.max(0, m.weeklySteps), 0);
  const milestoneReached = totalSteps >= target;
  const progress = Math.min(1, totalSteps / target);
  return {
    heading: BRAND_LEXICON.movementHeading,
    totalSteps,
    milestoneTarget: target,
    progress,
    milestoneReached,
    contributorCount: members.length,
    celebrationColor: semanticColors.celebration,
  };
}

// ---------------------------------------------------------------------------
// Sanctuary Shield banner (R34.3).
// ---------------------------------------------------------------------------

/** Presentation model for the calm Sanctuary Shield banner. */
export interface SanctuaryBannerView {
  readonly message: string;
  /** Temple Brass — the Sanctuary Shield banner color (R34.3). */
  readonly color: string;
}

/**
 * Build the calm Sanctuary Shield banner shown while Sanctuary_Mode is active,
 * indicating the shield is resting until the resumption time, in Temple Brass
 * (R34.3). `resumesAtLabel` is a pre-formatted, timezone-aware label supplied
 * by the surface.
 */
export function buildSanctuaryBanner(resumesAtLabel: string): SanctuaryBannerView {
  return {
    message: `${BRAND_LEXICON.sanctuaryBanner} until ${resumesAtLabel}`,
    color: semanticColors.celebration,
  };
}

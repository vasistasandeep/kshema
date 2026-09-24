/**
 * Content model for the interactive four-stage escalation ladder and the
 * zero-knowledge Flight_Recorder explainer (R30.2).
 *
 * The model is language-independent structure (stage ordering, palette role,
 * icon key); the human-readable copy for each stage lives in the i18n catalog
 * (see {@link ./catalog}) keyed by these stage ids, so all five Supported_
 * Languages stay in lockstep. Palette roles reference the shared `@kshema/ui`
 * semantic tokens — never raw hex, never clinical red / hospital blue.
 *
 * Requirements: 30.1, 30.2, 30.8.
 */
import type { SemanticColorToken } from "@kshema/ui";
import type { CatalogKey } from "./catalog.en";

/** Stable identifier for each rung of the escalation ladder. */
export type EscalationStageId = "stage1" | "stage2" | "stage3" | "stage4";

/** Structural definition of one escalation stage (copy comes from i18n). */
export interface EscalationStageDef {
  readonly id: EscalationStageId;
  /** 1-based position in the ladder; presentation must render strictly in order. */
  readonly order: 1 | 2 | 3 | 4;
  /** i18n key for the stage title. */
  readonly titleKey: CatalogKey;
  /** i18n key for the stage description. */
  readonly descriptionKey: CatalogKey;
  /**
   * Brand palette semantic role for the stage indicator. Early stages read as
   * calm/healthy; later stages escalate to amber. No stage uses a raw hex or a
   * banned clinical color (R16.4).
   */
  readonly paletteRole: Extract<SemanticColorToken, "healthy" | "escalating" | "primaryAction">;
  /** Approximate delay from the previous rung, in minutes, for the visual. */
  readonly delayMinutes: number;
}

/**
 * The four-stage escalation ladder, in strict order. Copy is resolved from the
 * i18n catalog at render time; this array only fixes the structure/ordering so
 * the interactive visual (R30.2) is identical across every language.
 */
export const ESCALATION_LADDER: readonly EscalationStageDef[] = [
  {
    id: "stage1",
    order: 1,
    titleKey: "escalation.stage1.title",
    descriptionKey: "escalation.stage1.desc",
    paletteRole: "healthy",
    delayMinutes: 0,
  },
  {
    id: "stage2",
    order: 2,
    titleKey: "escalation.stage2.title",
    descriptionKey: "escalation.stage2.desc",
    paletteRole: "escalating",
    delayMinutes: 20,
  },
  {
    id: "stage3",
    order: 3,
    titleKey: "escalation.stage3.title",
    descriptionKey: "escalation.stage3.desc",
    paletteRole: "escalating",
    delayMinutes: 20,
  },
  {
    id: "stage4",
    order: 4,
    titleKey: "escalation.stage4.title",
    descriptionKey: "escalation.stage4.desc",
    paletteRole: "primaryAction",
    delayMinutes: 20,
  },
];

/** i18n keys describing the zero-knowledge Flight_Recorder explainer (R30.2). */
export interface FlightRecorderExplainer {
  readonly headingKey: CatalogKey;
  /** Ordered list of i18n keys for the explainer bullet points. */
  readonly pointKeys: readonly CatalogKey[];
}

export const FLIGHT_RECORDER_EXPLAINER: FlightRecorderExplainer = {
  headingKey: "flightRecorder.heading",
  pointKeys: [
    "flightRecorder.point.snapshots",
    "flightRecorder.point.encrypted",
    "flightRecorder.point.serverBlind",
    "flightRecorder.point.release",
  ],
};

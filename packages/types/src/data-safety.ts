/**
 * @kshema/types — the app-store Data_Safety_Disclosure manifest (R27).
 *
 * This is the single, machine-readable source of truth for the platform's
 * app-store data-safety labels (Google Play Data safety / Apple Privacy
 * Nutrition Label). It declares EXACTLY the data the Kshema_App and
 * Kshema_API collect, plus the privacy affirmations, so a contract test
 * (`data-safety.test.ts`) can assert the disclosure stays consistent with the
 * actual DTO reality in this package (R27.5):
 *
 *   * device identifiers + push tokens for notification delivery (R27.1),
 *   * step-delta diagnostics for routine verification (R27.2),
 *   * no data sale / no cross-app tracking (R27.3),
 *   * no plaintext continuous location trace stored on servers (R27.4).
 *
 * The public portal (`apps/web`) renders the human-readable version of this
 * same disclosure; keeping it structured here lets the disclosure copy and
 * the actual data model be cross-checked mechanically rather than by prose
 * review.
 */

/**
 * The stable identifiers of the data categories Kshema declares collecting.
 * Each id maps to the concrete DTO field(s) that carry it, so the contract
 * test can prove the declaration matches what the schemas actually accept.
 */
export const DATA_SAFETY_CATEGORY_IDS = [
  "device_identifiers",
  "push_tokens",
  "step_delta_diagnostics",
] as const;
export type DataSafetyCategoryId = (typeof DATA_SAFETY_CATEGORY_IDS)[number];

/** One declared data category in the app-store data-safety labels. */
export interface DataSafetyCategory {
  /** Stable id used to cross-check against the DTO reality. */
  readonly id: DataSafetyCategoryId;
  /** App-store label group (Google Play / Apple parlance). */
  readonly label: string;
  /** Why the category is collected (the declared, single purpose). */
  readonly purpose: string;
  /** Whether this category is EVER shared with third parties. */
  readonly shared: boolean;
  /**
   * The concrete `@kshema/types` DTO field(s) that carry this category. The
   * contract test asserts at least one of these fields actually exists on the
   * declared schema, so a category can never be disclosed without a
   * corresponding real field (and vice-versa).
   */
  readonly dtoFields: readonly string[];
}

/**
 * The declared data categories. These MUST correspond one-for-one with real
 * DTO fields — asserted by the contract test against `HeartbeatSchema`
 * (`deviceId`, `stepDelta`) and `OtpVerifySchema` (`pushToken`).
 */
export const DATA_SAFETY_CATEGORIES: readonly DataSafetyCategory[] = [
  {
    id: "device_identifiers",
    label: "Device or other IDs",
    purpose: "Attribute passive telemetry to a device and deliver notifications.",
    shared: false,
    dtoFields: ["deviceId"],
  },
  {
    id: "push_tokens",
    label: "Device or other IDs",
    purpose: "Deliver check-in and escalation notifications.",
    shared: false,
    dtoFields: ["pushToken"],
  },
  {
    id: "step_delta_diagnostics",
    label: "App activity — diagnostics",
    purpose: "Infer the daily Routine_Rhythm to verify well-being.",
    shared: false,
    dtoFields: ["stepDelta"],
  },
] as const;

/**
 * The privacy affirmations the disclosure makes. Each is a boolean the
 * contract test cross-checks against structural facts in the data model.
 */
export interface DataSafetyAffirmations {
  /** DPDP + GDPR: user data is never sold or traded (R27.3, R30.7). */
  readonly dataNeverSold: boolean;
  /** No tracking of users across other companies' apps or sites (R27.3). */
  readonly noCrossAppTracking: boolean;
  /**
   * No plaintext continuous location trace is stored on servers during normal
   * operation; location transits only for a confirmed Stage-4 dispatch /
   * active Shadow_SOS as a point-in-time value (R27.4, R19.1, R19.5).
   */
  readonly noContinuousLocationOnServers: boolean;
  /**
   * The server is blind to sealed context: it stores ciphertext verbatim and
   * holds no private key / decrypt path (R8.6, R19.3).
   */
  readonly serverBlindToBlackBox: boolean;
}

/** The complete app-store Data_Safety_Disclosure manifest. */
export interface DataSafetyDisclosure {
  readonly categories: readonly DataSafetyCategory[];
  readonly affirmations: DataSafetyAffirmations;
}

/**
 * The canonical Data_Safety_Disclosure. Consumed by the app-store submission
 * tooling and mirrored by the public-portal `legal.dataSafety.*` copy.
 */
export const DATA_SAFETY_DISCLOSURE: DataSafetyDisclosure = {
  categories: DATA_SAFETY_CATEGORIES,
  affirmations: {
    dataNeverSold: true,
    noCrossAppTracking: true,
    noContinuousLocationOnServers: true,
    serverBlindToBlackBox: true,
  },
} as const;

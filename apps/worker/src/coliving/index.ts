/**
 * Co-living household worker logic (R35; task 16.3).
 *
 * Two behaviors:
 *  - {@link ./attribution.js} — shared Ghost_Signal attribution + the R35.2
 *    guard that a household signal alone does not confirm an Anchor requiring
 *    independent confirmation.
 *  - {@link ./partner-checkin.js} — the quiet high-priority STAGE_1 partner
 *    check-in delivered before any external Hyperlocal dispatch (R35.3), and
 *    resolution with `CO_LIVING_PARTNER_CONFIRMED` on partner confirmation
 *    (R35.4).
 */

export * from "./attribution.js";
export * from "./partner-checkin.js";
export * from "./rhythm-gate.js";

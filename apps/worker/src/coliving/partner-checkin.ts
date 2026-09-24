/**
 * Co-living partner check-in ordering (R35.3, R35.4; task 16.3).
 *
 * When a Safety_Incident escalates for one co-living Anchor, the worker must
 * first deliver a *quiet* high-priority `STAGE_1_CONVERSATIONAL_WHATSAPP`
 * check-in to the co-living partner's device **before** any external Hyperlocal
 * dispatch (R35.3, design "Partner check-in before external alerts"). If the
 * partner acknowledges and confirms the spouse is safe, the incident resolves
 * immediately with the `CO_LIVING_PARTNER_CONFIRMED` resolution source (R35.4)
 * and no external dispatch occurs.
 *
 * This module models that as an **injectable step** consulted at STAGE_1 for a
 * co-living Anchor. Every side effect lives behind a seam
 * ({@link PartnerCheckInDeps}) so the default wiring and the unit tests stay
 * hermetic:
 *
 *   - `lookupHousehold` — resolve the Anchor's {@link HouseholdProfileView}
 *     (Prisma `householdProfile.findFirst({ where: { anchorIds: { has } } })`
 *     in prod; a pure closure in tests). `null` ⇒ the Anchor is not co-living,
 *     so the step is a no-op and normal escalation continues.
 *   - `notifyPartner` — deliver the QUIET high-priority STAGE_1 check-in to the
 *     partner device(s) (`dispatch` queue in prod).
 *   - `resolve` — route to `resolveIncident` with `CO_LIVING_PARTNER_CONFIRMED`
 *     (already an AUTO_RESOLUTION_SOURCE — see `resolution/resolve.ts`).
 *
 * The ORDERING guarantee (R35.3) is enforced structurally: the partner check-in
 * is delivered, and the incident is resolved on confirmation, entirely within
 * this step — which the escalation path consults *before* it would ever reach
 * the STAGE_4 external Hyperlocal dispatch. When the step reports
 * `resolved: true`, the caller MUST NOT proceed to external dispatch.
 */

import type { ResolutionSource } from "@kshema/database";

import { coLivingPartnersOf, type HouseholdProfileView } from "./attribution.js";

/** The resolution source recorded on a co-living partner confirmation (R35.4). */
export const CO_LIVING_PARTNER_CONFIRMED: ResolutionSource =
  "CO_LIVING_PARTNER_CONFIRMED";

/**
 * The quiet high-priority partner check-in delivered at STAGE_1 (R35.3).
 *
 * `quiet: true` and `priority: "high"` are carried explicitly so the `dispatch`
 * layer renders a *non-alarming* but prompt notification (design "a quiet
 * high-priority STAGE_1 check-in"). It is a `STAGE_1_CONVERSATIONAL_WHATSAPP`
 * check-in, NOT an external Hyperlocal dispatch.
 */
export interface PartnerCheckIn {
  incidentId: string;
  /** The co-living Anchor the incident is about (the "spouse"). */
  subjectAnchorId: string;
  /** The partner Anchor(s) to notify — the other household members (R35.3). */
  partnerAnchorIds: string[];
  /** Always the conversational STAGE_1 stage; never an external dispatch stage. */
  stage: "STAGE_1_CONVERSATIONAL_WHATSAPP";
  /** Quiet delivery: prompt but non-alarming (R35.3). */
  quiet: true;
  /** High priority so it beats the routine backlog (R35.3). */
  priority: "high";
}

/** The partner's response to the quiet STAGE_1 check-in. */
export interface PartnerResponse {
  /** `true` iff the partner acknowledged AND confirmed the spouse is safe (R35.4). */
  confirmedSafe: boolean;
}

/** Injectable side-effect seams for the co-living partner check-in step. */
export interface PartnerCheckInDeps {
  /**
   * Resolve the {@link HouseholdProfileView} the Anchor co-lives in, or `null`
   * when the Anchor is not part of any co-living household. Production wiring
   * queries `HouseholdProfile`; tests pass a pure closure.
   */
  lookupHousehold: (
    anchorId: string,
  ) => Promise<HouseholdProfileView | null> | (HouseholdProfileView | null);
  /**
   * Deliver the QUIET high-priority STAGE_1 check-in to the partner device(s)
   * (R35.3) and resolve to the partner's response. Production wiring enqueues a
   * `dispatch` job and awaits the inbound acknowledgement (or a timeout ⇒
   * `confirmedSafe: false`); tests pass a spy.
   */
  notifyPartner: (
    checkIn: PartnerCheckIn,
  ) => Promise<PartnerResponse> | PartnerResponse;
  /**
   * Resolve the incident with `CO_LIVING_PARTNER_CONFIRMED` (R35.4). Production
   * wiring closes over `resolveIncident(resolutionDeps, { incidentId, source:
   * CO_LIVING_PARTNER_CONFIRMED, now })`; tests pass a spy. MUST be idempotent
   * (the underlying conditional transition already is).
   */
  resolve: (input: {
    incidentId: string;
    source: ResolutionSource;
    now: number;
  }) => Promise<void> | void;
}

/** Inputs to run the co-living partner check-in step at STAGE_1 (R35.3/R35.4). */
export interface PartnerCheckInInput {
  incidentId: string;
  /** The escalating co-living Anchor. */
  anchorId: string;
  /** Wall-clock now (epoch-millis); injected for deterministic tests. */
  now: number;
}

/** Outcome of {@link runPartnerCheckIn}. */
export interface PartnerCheckInResult {
  /** `true` iff the Anchor is in a co-living household with at least one partner. */
  coLiving: boolean;
  /** `true` iff a quiet STAGE_1 partner check-in was delivered (R35.3). */
  checkInDelivered: boolean;
  /** `true` iff the partner confirmed the spouse safe and the incident resolved (R35.4). */
  resolved: boolean;
  /**
   * `true` iff the caller MAY proceed to external Hyperlocal dispatch. This is
   * `false` exactly when the incident was resolved by the partner (R35.4): a
   * confirmed partner check-in supersedes external dispatch. It is also `true`
   * for a non-co-living Anchor (nothing to gate on).
   */
  mayProceedToExternalDispatch: boolean;
  /** The partner Anchor ids notified (empty when not co-living). */
  partnerAnchorIds: string[];
}

/**
 * Run the co-living partner check-in step for an escalating Anchor (R35.3/R35.4).
 *
 * Order of operations mirrors the design sequence diagram:
 *   1. look up the Anchor's household; if not co-living (or no partner), this is
 *      a NO-OP that permits normal escalation to continue
 *      (`mayProceedToExternalDispatch: true`).
 *   2. deliver the QUIET high-priority STAGE_1 check-in to the partner
 *      device(s) — this happens BEFORE any external Hyperlocal dispatch (R35.3).
 *   3. if the partner confirms the spouse is safe, resolve the incident with
 *      `CO_LIVING_PARTNER_CONFIRMED` (R35.4) and report
 *      `mayProceedToExternalDispatch: false` so the caller skips external
 *      dispatch entirely.
 *   4. if the partner does NOT confirm, report `mayProceedToExternalDispatch:
 *      true` so the escalation ladder proceeds to external Hyperlocal dispatch.
 *
 * The step performs the partner notification and (on confirmation) the
 * resolution itself, and it is invoked BEFORE the STAGE_4 external dispatch — so
 * the "partner check-in fires before external dispatch" ordering (R35.3) holds
 * by construction.
 */
export async function runPartnerCheckIn(
  deps: PartnerCheckInDeps,
  input: PartnerCheckInInput,
): Promise<PartnerCheckInResult> {
  const profile = await deps.lookupHousehold(input.anchorId);
  const partnerAnchorIds = profile
    ? coLivingPartnersOf(input.anchorId, profile)
    : [];

  if (!profile || partnerAnchorIds.length === 0) {
    // Not co-living (or sole resident): nothing to gate on — proceed normally.
    return {
      coLiving: false,
      checkInDelivered: false,
      resolved: false,
      mayProceedToExternalDispatch: true,
      partnerAnchorIds: [],
    };
  }

  // Deliver the QUIET high-priority STAGE_1 check-in BEFORE any external
  // dispatch (R35.3).
  const checkIn: PartnerCheckIn = {
    incidentId: input.incidentId,
    subjectAnchorId: input.anchorId,
    partnerAnchorIds,
    stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
    quiet: true,
    priority: "high",
  };
  const response = await deps.notifyPartner(checkIn);

  if (response.confirmedSafe) {
    // Partner confirmed the spouse safe ⇒ resolve immediately with
    // CO_LIVING_PARTNER_CONFIRMED and DO NOT dispatch externally (R35.4).
    await deps.resolve({
      incidentId: input.incidentId,
      source: CO_LIVING_PARTNER_CONFIRMED,
      now: input.now,
    });
    return {
      coLiving: true,
      checkInDelivered: true,
      resolved: true,
      mayProceedToExternalDispatch: false,
      partnerAnchorIds,
    };
  }

  // No partner confirmation ⇒ escalation may proceed to external dispatch.
  return {
    coLiving: true,
    checkInDelivered: true,
    resolved: false,
    mayProceedToExternalDispatch: true,
    partnerAnchorIds,
  };
}

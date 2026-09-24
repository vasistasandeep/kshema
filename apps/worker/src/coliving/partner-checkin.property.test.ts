// Feature: kshema-safety-platform, Property 26: Co-living partner confirmation
// resolves before external dispatch. For all Safety_Incidents escalating for a
// co-living Anchor, a quiet high-priority STAGE_1 check-in SHALL be delivered
// to the co-living partner device before any external Hyperlocal dispatch, and
// if the partner acknowledges the spouse as safe the incident SHALL resolve
// immediately with resolution source CO_LIVING_PARTNER_CONFIRMED and no
// external dispatch SHALL occur.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { HouseholdProfileView } from "./attribution.js";
import {
  CO_LIVING_PARTNER_CONFIRMED,
  runPartnerCheckIn,
  type PartnerCheckIn,
  type PartnerCheckInDeps,
  type PartnerResponse,
} from "./partner-checkin.js";

/**
 * Validates: Requirements 35.3, 35.4
 *
 * Property 26 asserts, across arbitrary household profiles (co-living vs
 * sole-resident vs not-a-member) and arbitrary partner responses, that the
 * co-living partner check-in step:
 *   (a) R35.3 — for a co-living Anchor, ALWAYS delivers the quiet high-priority
 *       STAGE_1 partner check-in (`notifyPartner`) strictly BEFORE any external
 *       Hyperlocal dispatch could occur. Ordering is proven by a shared
 *       call-order log written by the `notifyPartner` seam and a would-be
 *       `externalDispatch` spy the simulated caller only fires when the step
 *       permits it. When the partner confirms safe, the incident resolves with
 *       `CO_LIVING_PARTNER_CONFIRMED`, `mayProceedToExternalDispatch` is
 *       `false`, and external dispatch NEVER runs (R35.4).
 *   (b) when the partner does NOT confirm, `mayProceedToExternalDispatch` is
 *       `true` and — crucially — the partner check-in still landed in the order
 *       log strictly before the external dispatch.
 *   (c) a non-co-living Anchor (household lookup returns `null`, a sole-resident
 *       household, or an Anchor absent from the profile) is a NO-OP: no
 *       check-in, no resolve, `mayProceedToExternalDispatch` is `true`.
 *
 * Generators straddle every branch: co-living households of 2..5 members, sole
 * residents, an Anchor that is not a household member, absent households, and
 * both partner responses.
 */

const SEG = fc.hexaString({ minLength: 2, maxLength: 2 });
const bssid = () =>
  fc
    .array(SEG, { minLength: 6, maxLength: 6 })
    .map((parts) => parts.join(":"));

const anchorId = fc.string({ minLength: 1, maxLength: 12 }).map((s) => `a:${s}`);

/** A profile shape describing how the Anchor relates to its household. */
type Scenario =
  | { kind: "co-living"; profile: HouseholdProfileView; anchorId: string }
  | { kind: "sole-resident"; profile: HouseholdProfileView; anchorId: string }
  | { kind: "not-member"; profile: HouseholdProfileView; anchorId: string }
  | { kind: "no-household"; profile: null; anchorId: string };

/** Distinct-anchor list generator (2..6 unique ids). */
const distinctAnchors = fc
  .uniqueArray(anchorId, { minLength: 2, maxLength: 6 })
  .filter((ids) => ids.length >= 2);

const householdName = fc.string({ minLength: 1, maxLength: 24 });

const profileFrom = (
  name: string,
  anchorIds: readonly string[],
  wifis: readonly string[],
  media: readonly string[],
): HouseholdProfileView => ({
  householdName: name,
  anchorIds,
  sharedWifiBssids: wifis,
  sharedMediaDeviceIds: media,
});

const sharedWifis = fc.array(bssid(), { maxLength: 3 });
const sharedMedia = fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
  maxLength: 3,
});

const coLivingScenario: fc.Arbitrary<Scenario> = fc
  .tuple(householdName, distinctAnchors, sharedWifis, sharedMedia, fc.nat())
  .map(([name, ids, wifis, media, pick]) => {
    const subject = ids[pick % ids.length]!;
    return {
      kind: "co-living" as const,
      profile: profileFrom(name, ids, wifis, media),
      anchorId: subject,
    };
  });

const soleResidentScenario: fc.Arbitrary<Scenario> = fc
  .tuple(householdName, anchorId, sharedWifis, sharedMedia)
  .map(([name, id, wifis, media]) => ({
    kind: "sole-resident" as const,
    profile: profileFrom(name, [id], wifis, media),
    anchorId: id,
  }));

const notMemberScenario: fc.Arbitrary<Scenario> = fc
  .tuple(householdName, distinctAnchors, anchorId, sharedWifis, sharedMedia)
  .filter(([, ids, outsider]) => !ids.includes(outsider))
  .map(([name, ids, outsider, wifis, media]) => ({
    kind: "not-member" as const,
    profile: profileFrom(name, ids, wifis, media),
    anchorId: outsider,
  }));

const noHouseholdScenario: fc.Arbitrary<Scenario> = anchorId.map((id) => ({
  kind: "no-household" as const,
  profile: null,
  anchorId: id,
}));

const scenario: fc.Arbitrary<Scenario> = fc.oneof(
  coLivingScenario,
  soleResidentScenario,
  notMemberScenario,
  noHouseholdScenario,
);

describe("runPartnerCheckIn — Property 26 (R35.3/R35.4)", () => {
  it("delivers the partner check-in before external dispatch; confirmation resolves and blocks dispatch", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenario,
        fc.boolean(), // partner response: confirmedSafe?
        fc.string({ minLength: 1, maxLength: 8 }), // incidentId
        fc.integer({ min: 0, max: 2 ** 40 }), // now
        async (sc, confirmedSafe, incidentId, now) => {
          // A single shared call-order log written by BOTH the partner check-in
          // seam and the would-be external dispatch spy. Ordering (R35.3) is
          // asserted purely from this log.
          const order: string[] = [];
          let checkInSeen: PartnerCheckIn | null = null;
          let notifyCalls = 0;
          let resolveCalls = 0;
          let resolveArgs:
            | { incidentId: string; source: string; now: number }
            | null = null;

          const deps: PartnerCheckInDeps = {
            lookupHousehold: () => sc.profile,
            notifyPartner: (checkIn): PartnerResponse => {
              notifyCalls += 1;
              checkInSeen = checkIn;
              order.push("partner_checkin");
              return { confirmedSafe };
            },
            resolve: (args) => {
              resolveCalls += 1;
              resolveArgs = args;
              order.push("resolve");
            },
          };

          const result = await runPartnerCheckIn(deps, {
            incidentId,
            anchorId: sc.anchorId,
            now,
          });

          // Simulate the escalation caller: only dispatch externally if the
          // step permits it. This records "external_dispatch" in the SAME log.
          const externalDispatch = (): void => {
            order.push("external_dispatch");
          };
          if (result.mayProceedToExternalDispatch) externalDispatch();

          const isCoLiving = sc.kind === "co-living";

          if (!isCoLiving) {
            // (c) Non-co-living Anchor is a strict no-op that permits normal
            // escalation. No check-in, no resolve.
            expect(result.coLiving).toBe(false);
            expect(result.checkInDelivered).toBe(false);
            expect(result.resolved).toBe(false);
            expect(result.mayProceedToExternalDispatch).toBe(true);
            expect(result.partnerAnchorIds).toEqual([]);
            expect(notifyCalls).toBe(0);
            expect(resolveCalls).toBe(0);
            // Nothing preceded the (permitted) external dispatch.
            expect(order).toEqual(["external_dispatch"]);
            return;
          }

          // ---- co-living Anchor ----
          expect(result.coLiving).toBe(true);
          expect(result.checkInDelivered).toBe(true);
          expect(notifyCalls).toBe(1);
          expect(result.partnerAnchorIds.length).toBeGreaterThanOrEqual(1);
          expect(result.partnerAnchorIds).not.toContain(sc.anchorId);

          // (a) The delivered check-in is the QUIET high-priority STAGE_1
          // conversational check-in — never an external dispatch stage (R35.3).
          const delivered = checkInSeen as PartnerCheckIn | null;
          expect(delivered).not.toBeNull();
          expect(delivered!.stage).toBe("STAGE_1_CONVERSATIONAL_WHATSAPP");
          expect(delivered!.quiet).toBe(true);
          expect(delivered!.priority).toBe("high");
          expect(delivered!.subjectAnchorId).toBe(sc.anchorId);
          expect(delivered!.incidentId).toBe(incidentId);

          // Ordering guarantee (R35.3): the partner check-in is ALWAYS the
          // first entry, i.e. it precedes anything external.
          expect(order[0]).toBe("partner_checkin");
          const externalIdx = order.indexOf("external_dispatch");
          if (externalIdx !== -1) {
            expect(order.indexOf("partner_checkin")).toBeLessThan(externalIdx);
          }

          if (confirmedSafe) {
            // (a) Partner confirmed safe ⇒ resolve with
            // CO_LIVING_PARTNER_CONFIRMED and BLOCK external dispatch (R35.4).
            expect(result.resolved).toBe(true);
            expect(result.mayProceedToExternalDispatch).toBe(false);
            expect(resolveCalls).toBe(1);
            expect(resolveArgs).toEqual({
              incidentId,
              source: CO_LIVING_PARTNER_CONFIRMED,
              now,
            });
            // External dispatch NEVER runs; the log ends at resolve.
            expect(order).toEqual(["partner_checkin", "resolve"]);
            expect(order).not.toContain("external_dispatch");
          } else {
            // (b) No confirmation ⇒ escalation may proceed, but the partner
            // check-in still fired strictly before the external dispatch.
            expect(result.resolved).toBe(false);
            expect(result.mayProceedToExternalDispatch).toBe(true);
            expect(resolveCalls).toBe(0);
            expect(order).toEqual(["partner_checkin", "external_dispatch"]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

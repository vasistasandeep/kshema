// Feature: kshema-safety-platform, Property 15: For all
// Hyperlocal_Contact_Profiles and incident contexts, the generated voice and
// text dispatch message SHALL include the Anchor building, flat, society, and
// door-access details PRESENT in the profile — and SHALL omit any absent/blank
// field without leaving an empty "Flat: ." placeholder. The ordered contact
// list (Primary Observer -> gate -> neighbor) reflects only present phones.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assembleHyperlocalMessage,
  assembleHyperlocalDispatch,
  HYPERLOCAL_CONTACT_IDS,
  HYPERLOCAL_CONTACT_LABELS,
  type HyperlocalProfileInput,
} from "./hyperlocal.js";

/**
 * Validates: Requirements 14.2, 14.4
 *
 * Property 15 asserts field completeness of the dynamically-generated
 * Hyperlocal_Dispatch message across arbitrary profiles and incident contexts.
 *
 * The generators straddle the present/absent boundary for EACH address field
 * (building / flat / society / door-access) independently: a field is either a
 * non-blank value, or one of the "absent" forms — `null`, `undefined`, or a
 * whitespace-only blank — all of which must contribute NO segment. The same
 * present/absent generation is applied to each contact phone so the ordered
 * contact list can be checked against exactly the present phones.
 *
 * The oracle recomputes, independently of the module under test, which fields
 * are present (trimmed, non-empty) and asserts:
 *   - every present field's VALUE appears in the message (voice) and SMS body;
 *   - every absent field's LABEL does NOT appear (no empty "Flat: ." leftover);
 *   - the contact ordering is exactly the present phones in the fixed
 *     Primary Observer -> gate -> neighbor order (R14.1).
 */
describe("hyperlocal dispatch — Property 15 (R14.2 / R14.4 message completeness)", () => {
  // The four segment labels. A generated present value must not embed one of
  // these tokens, otherwise a present field's value could incidentally satisfy
  // the "<other label>:" collision the absent-field check guards against — a
  // generation artifact, not a behavior under test.
  const LABEL_TOKENS = ["Society:", "Building:", "Flat:", "Door access:"];

  // A present field: a non-blank string (whitespace still exercised inside the
  // value), excluding any label token so it can never collide with an
  // omitted-field label. Punctuation like "." is intentionally allowed so
  // values such as "." produce legitimate "<Label>: ." segments.
  const presentValue = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => s.trim().length > 0)
    .filter((s) => !LABEL_TOKENS.some((t) => s.includes(t)));

  // An "absent" field: null, undefined, or a whitespace-only blank. All three
  // must yield no message segment (no empty placeholder).
  const absentValue = fc.oneof(
    fc.constant<string | null | undefined>(null),
    fc.constant<string | null | undefined>(undefined),
    fc.constantFrom(" ", "   ", "\t", "\n  ", "\t \n"),
  );

  // A field independently present-non-blank OR absent/blank.
  const optionalField = fc.oneof(presentValue, absentValue);

  const profileArb: fc.Arbitrary<HyperlocalProfileInput> = fc.record({
    building: optionalField,
    flat: optionalField,
    society: optionalField,
    doorAccess: optionalField,
    primaryObserverPhone: optionalField,
    gatePhone: optionalField,
    neighborPhone: optionalField,
  });

  // Anchor name straddles the fallback boundary: a real name, explicit null,
  // and whitespace-only blanks (all blanks fall back to "the resident").
  const anchorName = fc.oneof(
    fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    fc.constant<string | null>(null),
    fc.constantFrom(" ", "   ", "\t"),
  );

  const contextArb = fc.record({
    incidentId: fc.string({ minLength: 1, maxLength: 12 }),
    anchorName,
  });

  const scenarioArb = fc.record({
    profile: profileArb,
    context: contextArb,
  });

  const present = (v?: string | null): string | undefined => {
    const t = v?.trim();
    return t && t.length > 0 ? t : undefined;
  };

  it("includes every present address detail and omits every absent field", () => {
    fc.assert(
      fc.property(scenarioArb, ({ profile, context }) => {
        const message = assembleHyperlocalMessage(profile, context);
        const dispatch = assembleHyperlocalDispatch(profile, context);

        // The SMS body reuses the same dynamic message (R14.3).
        expect(dispatch.smsBody).toBe(dispatch.messageText);
        expect(dispatch.messageText).toBe(message);

        // Independent oracle for the four address fields and their labels.
        const fields: Array<{ label: string; value?: string }> = [
          { label: "Society", value: present(profile.society) },
          { label: "Building", value: present(profile.building) },
          { label: "Flat", value: present(profile.flat) },
          { label: "Door access", value: present(profile.doorAccess) },
        ];

        for (const f of fields) {
          if (f.value !== undefined) {
            // Present field: its value AND labelled segment appear (R14.2/R14.4).
            expect(message).toContain(f.value);
            expect(message).toContain(`${f.label}: ${f.value}.`);
          } else {
            // Absent/blank field: its label never appears — no empty
            // placeholder. This label-level check IS the "no empty
            // placeholder" guarantee: an omitted field contributes no
            // "<Label>: ." segment at all. (We deliberately do not assert on a
            // bare ": ." token because a PRESENT value may itself be a "."
            // producing a legitimate "Society: ." segment.)
            expect(message).not.toContain(`${f.label}:`);
          }
        }

        // Contact ordering reflects ONLY present phones, in the fixed
        // Primary Observer -> gate -> neighbor order (R14.1).
        const expectedContacts = [
          {
            id: HYPERLOCAL_CONTACT_IDS.primaryObserver,
            label: HYPERLOCAL_CONTACT_LABELS.primaryObserver,
            phone: present(profile.primaryObserverPhone),
          },
          {
            id: HYPERLOCAL_CONTACT_IDS.gate,
            label: HYPERLOCAL_CONTACT_LABELS.gate,
            phone: present(profile.gatePhone),
          },
          {
            id: HYPERLOCAL_CONTACT_IDS.neighbor,
            label: HYPERLOCAL_CONTACT_LABELS.neighbor,
            phone: present(profile.neighborPhone),
          },
        ]
          .filter((c) => c.phone !== undefined)
          .map((c) => ({ id: c.id, phone: c.phone as string, label: c.label }));

        expect(dispatch.contacts).toEqual(expectedContacts);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: kshema-safety-platform, Property 17: For all (Admin_Role, action)
// pairs, the action SHALL be permitted if and only if it belongs to the role's
// permitted set (out-of-role actions are always denied); and for all rendered
// User/Circle phone numbers, the number SHALL be masked to its last 4 digits
// EXCEPT within an active Stage-4 triage session opened by an authorized
// SUPPORT_AGENT (in which case the full number is rendered).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AdminRoleSchema } from "@kshema/types";
import type { AdminRole } from "@kshema/types";

import {
  ADMIN_PERMISSIONS,
  isPermitted,
  maskPhone,
  type AdminCapability,
} from "./admin.js";

/**
 * Validates: Requirements 21.2, 21.3, 21.4, 21.5, 21.8
 *
 * Property 17 has two independent halves, each exercised across the full
 * (role × capability) and (phone × triage-flag) input spaces with an oracle
 * recomputed independently of the module under test:
 *
 *  (a) RBAC (R21.2-R21.5): a capability is permitted IFF the role is a member
 *      of that capability's set in {@link ADMIN_PERMISSIONS}. The oracle reads
 *      the matrix membership directly, so the property proves `isPermitted`
 *      never grants a role a capability outside its set (out-of-role => denied)
 *      and never denies one inside it.
 *
 *  (b) Phone masking (R21.8): by default every rendered number collapses to its
 *      last 4 digits (leading digits hidden), and this is the ONLY digits that
 *      survive; the sole exception is an active Stage-4 triage session, in which
 *      the full original string is returned verbatim.
 */
describe("admin RBAC + phone masking — Property 17 (R21.2-R21.5, R21.8)", () => {
  const ROLES = AdminRoleSchema.options as readonly AdminRole[];
  const CAPABILITIES = Object.keys(ADMIN_PERMISSIONS) as AdminCapability[];

  const roleArb = fc.constantFrom(...ROLES);
  const capabilityArb = fc.constantFrom(...CAPABILITIES);

  it("(a) permits a capability IFF the role is in the matrix; out-of-role is always denied", () => {
    fc.assert(
      fc.property(roleArb, capabilityArb, (role, capability) => {
        // Independent oracle: membership in the capability's permitted set.
        const expected = ADMIN_PERMISSIONS[capability].has(role);
        expect(isPermitted(role, capability)).toBe(expected);

        // The IFF, spelled out: every role NOT in the set is denied, and the
        // denied roles are exactly the complement of the permitted set.
        const permittedRoles = ROLES.filter((r) => isPermitted(r, capability));
        const inSet = permittedRoles.includes(role);
        expect(isPermitted(role, capability)).toBe(inSet);
        if (!ADMIN_PERMISSIONS[capability].has(role)) {
          expect(isPermitted(role, capability)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  // A phone-number-ish generator: a mix of digits and common separators/prefix
  // characters ("+", "-", spaces, parens) so masking is exercised over both the
  // digit-extraction and the non-digit-prefix-hiding behavior. Ensures at least
  // one digit is present so "last 4 digits" is meaningful across the range.
  const phoneArb = fc
    .stringMatching(/^[+()\-\s0-9]{1,20}$/)
    .filter((s) => /\d/.test(s));

  it("(b) masks to the last 4 digits by default, and only reveals the full number during active Stage-4 triage", () => {
    fc.assert(
      fc.property(phoneArb, fc.boolean(), (phone, activeStage4Triage) => {
        const rendered = maskPhone(phone, { activeStage4Triage });

        if (activeStage4Triage) {
          // The one exception: an active Stage-4 triage returns the full number.
          expect(rendered).toBe(phone);
          return;
        }

        // Default: independent oracle for the masked form.
        const digits = phone.replace(/\D/g, "");
        const last4 = digits.slice(-4);
        const hidden = Math.max(digits.length - last4.length, 0);
        const expected = `${"•".repeat(hidden)}${last4}`;

        expect(rendered).toBe(expected);

        // The rendered value ends in exactly the last 4 (or fewer) real digits,
        // and NO other digit from the original number survives unmasked.
        expect(rendered.replace(/\D/g, "")).toBe(last4);
        // Masking never lengthens the string.
        expect(rendered.length).toBeLessThanOrEqual(phone.length);
        // At most 4 digits are ever revealed.
        expect(rendered.replace(/\D/g, "").length).toBeLessThanOrEqual(4);
      }),
      { numRuns: 200 },
    );
  });
});

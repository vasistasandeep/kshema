/**
 * Unit tests for the client-side RBAC mirror (R21.2–R21.5).
 *
 * These assert the console's permission map matches the requirements' single-
 * role matrix exactly, so out-of-role affordances are hidden/disabled to mirror
 * the authoritative server guard.
 */
import { describe, expect, it } from "vitest";
import type { AdminRole } from "@kshema/types";
import {
  ADMIN_PERMISSIONS,
  isPermitted,
  visibleSections,
  CONSOLE_SECTIONS,
  type AdminCapability,
} from "./rbac";

const ALL_ROLES: AdminRole[] = ["SUPER_ADMIN", "SUPPORT_AGENT", "BILLING_OPS"];

describe("ADMIN_PERMISSIONS matrix (R21.2–R21.4)", () => {
  it("grants SUPER_ADMIN every capability", () => {
    for (const cap of Object.keys(ADMIN_PERMISSIONS) as AdminCapability[]) {
      expect(isPermitted("SUPER_ADMIN", cap)).toBe(true);
    }
  });

  it("restricts SUPPORT_AGENT to fleet/carrier/incident ops + retry + wakefulness", () => {
    const permitted = (Object.keys(ADMIN_PERMISSIONS) as AdminCapability[]).filter(
      (c) => isPermitted("SUPPORT_AGENT", c),
    );
    expect(new Set(permitted)).toEqual(
      new Set([
        "FLEET_PULSE_VIEW",
        "CARRIER_HEALTH_VIEW",
        "LIVE_INCIDENTS_VIEW",
        "RETRY_DISPATCH",
        "WAKEFULNESS_TEST",
      ]),
    );
  });

  it("restricts BILLING_OPS to subscriptions + trial extension + webhook queue", () => {
    const permitted = (Object.keys(ADMIN_PERMISSIONS) as AdminCapability[]).filter(
      (c) => isPermitted("BILLING_OPS", c),
    );
    expect(new Set(permitted)).toEqual(
      new Set(["SUBSCRIPTIONS_VIEW", "TRIAL_EXTENSION", "WEBHOOK_ERROR_QUEUE_VIEW"]),
    );
  });

  it("permits the DPDP/GDPR purge only for SUPER_ADMIN (R21.21)", () => {
    expect(isPermitted("SUPER_ADMIN", "PURGE_REQUEST")).toBe(true);
    expect(isPermitted("SUPPORT_AGENT", "PURGE_REQUEST")).toBe(false);
    expect(isPermitted("BILLING_OPS", "PURGE_REQUEST")).toBe(false);
  });
});

describe("visibleSections nav gating", () => {
  it("hides out-of-role sections for each role", () => {
    for (const role of ALL_ROLES) {
      const visible = visibleSections(role);
      // Every visible section is one the role is actually permitted to use.
      for (const s of visible) {
        expect(isPermitted(role, s.capability)).toBe(true);
      }
      // No permitted, navigable section is omitted.
      const permittedSections = CONSOLE_SECTIONS.filter((s) =>
        isPermitted(role, s.capability),
      );
      expect(visible).toEqual(permittedSections);
    }
  });

  it("shows a BILLING_OPS operator the subscription/webhook sections but not fleet ops", () => {
    const hrefs = visibleSections("BILLING_OPS").map((s) => s.href);
    expect(hrefs).toContain("/subscriptions");
    expect(hrefs).toContain("/webhooks");
    expect(hrefs).not.toContain("/fleet");
    expect(hrefs).not.toContain("/purge");
  });
});

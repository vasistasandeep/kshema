/**
 * Unit tests for the admin console service layer (task 19.1 — R21).
 *
 * Covers the PURE pieces the routes depend on: the single-role RBAC matrix
 * (R21.2-R21.5), phone masking (R21.8), the telemetry-at-risk flag (R21.16),
 * the carrier error-rate on-call trip (R21.14), and the JWT admin session
 * verifier (MFA + single role, R21.1).
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  isPermitted,
  maskPhone,
  isTelemetryAtRisk,
  TELEMETRY_AT_RISK_SILENCE_MS,
  computeCarrierErrorRate,
  exceedsCarrierAlertThreshold,
  CARRIER_ALERT_THRESHOLD,
  JwtAdminSessionVerifier,
  type AdminCapability,
  type JwtVerifier,
} from "./admin.js";
import type { AdminRole } from "@kshema/types";

const ROLES: AdminRole[] = ["SUPER_ADMIN", "SUPPORT_AGENT", "BILLING_OPS"];

describe("ADMIN_PERMISSIONS / isPermitted (R21.2-R21.5)", () => {
  it("grants SUPPORT_AGENT the operational views + retries but not billing/purge", () => {
    expect(isPermitted("SUPPORT_AGENT", "FLEET_PULSE_VIEW")).toBe(true);
    expect(isPermitted("SUPPORT_AGENT", "CARRIER_HEALTH_VIEW")).toBe(true);
    expect(isPermitted("SUPPORT_AGENT", "LIVE_INCIDENTS_VIEW")).toBe(true);
    expect(isPermitted("SUPPORT_AGENT", "RETRY_DISPATCH")).toBe(true);
    expect(isPermitted("SUPPORT_AGENT", "WAKEFULNESS_TEST")).toBe(true);
    // Out of role for a support agent:
    expect(isPermitted("SUPPORT_AGENT", "SUBSCRIPTIONS_VIEW")).toBe(false);
    expect(isPermitted("SUPPORT_AGENT", "TRIAL_EXTENSION")).toBe(false);
    expect(isPermitted("SUPPORT_AGENT", "PURGE_REQUEST")).toBe(false);
    expect(isPermitted("SUPPORT_AGENT", "WEBHOOK_ERROR_QUEUE_VIEW")).toBe(false);
  });

  it("grants BILLING_OPS the billing surfaces but not operational retries/purge", () => {
    expect(isPermitted("BILLING_OPS", "SUBSCRIPTIONS_VIEW")).toBe(true);
    expect(isPermitted("BILLING_OPS", "TRIAL_EXTENSION")).toBe(true);
    expect(isPermitted("BILLING_OPS", "WEBHOOK_ERROR_QUEUE_VIEW")).toBe(true);
    // Out of role for billing:
    expect(isPermitted("BILLING_OPS", "RETRY_DISPATCH")).toBe(false);
    expect(isPermitted("BILLING_OPS", "WAKEFULNESS_TEST")).toBe(false);
    expect(isPermitted("BILLING_OPS", "PURGE_REQUEST")).toBe(false);
    expect(isPermitted("BILLING_OPS", "FLEET_PULSE_VIEW")).toBe(false);
  });

  it("grants SUPER_ADMIN every capability (superset)", () => {
    for (const cap of Object.keys(ADMIN_PERMISSIONS) as AdminCapability[]) {
      expect(isPermitted("SUPER_ADMIN", cap)).toBe(true);
    }
  });

  it("reserves the DPDP/GDPR purge for SUPER_ADMIN only (R21.21)", () => {
    const allowed = ROLES.filter((r) => isPermitted(r, "PURGE_REQUEST"));
    expect(allowed).toEqual(["SUPER_ADMIN"]);
  });
});

describe("maskPhone (R21.8)", () => {
  it("masks to the last 4 digits by default", () => {
    expect(maskPhone("+919876543210")).toBe("••••••••3210");
  });

  it("returns the full number only during an active Stage-4 triage", () => {
    expect(maskPhone("+919876543210", { activeStage4Triage: true })).toBe(
      "+919876543210",
    );
  });

  it("never lengthens a short number", () => {
    expect(maskPhone("12")).toBe("12");
  });
});

describe("isTelemetryAtRisk (R21.16)", () => {
  const now = new Date("2024-06-01T10:00:00.000Z");

  it("flags a device silent >= 45 minutes", () => {
    const silent = new Date(now.getTime() - TELEMETRY_AT_RISK_SILENCE_MS);
    expect(isTelemetryAtRisk(silent, now)).toBe(true);
  });

  it("does not flag a device that checked in recently", () => {
    const recent = new Date(now.getTime() - 10 * 60 * 1000);
    expect(isTelemetryAtRisk(recent, now)).toBe(false);
  });

  it("flags a device that has never checked in", () => {
    expect(isTelemetryAtRisk(null, now)).toBe(true);
  });
});

describe("carrier error-rate on-call trip (R21.14)", () => {
  it("computes the fraction, treating an empty window as 0", () => {
    expect(computeCarrierErrorRate(6, 100)).toBeCloseTo(0.06);
    expect(computeCarrierErrorRate(0, 0)).toBe(0);
  });

  it("trips strictly above 5% only", () => {
    expect(exceedsCarrierAlertThreshold(CARRIER_ALERT_THRESHOLD)).toBe(false);
    expect(exceedsCarrierAlertThreshold(0.0501)).toBe(true);
    expect(exceedsCarrierAlertThreshold(0.049)).toBe(false);
  });
});

describe("JwtAdminSessionVerifier (R21.1 MFA + single role)", () => {
  const makeVerifier = (payload: unknown): JwtVerifier => ({
    verify: () => payload as never,
  });

  it("returns a session for a valid MFA admin token", () => {
    const v = new JwtAdminSessionVerifier(
      makeVerifier({ sub: "admin_1", adminRole: "SUPER_ADMIN", mfa: true }),
    );
    expect(v.verify("Bearer tok")).toEqual({
      adminUserId: "admin_1",
      role: "SUPER_ADMIN",
      mfa: true,
    });
  });

  it("reports mfa:false when the MFA claim is absent (guard denies)", () => {
    const v = new JwtAdminSessionVerifier(
      makeVerifier({ sub: "admin_1", adminRole: "SUPPORT_AGENT" }),
    );
    expect(v.verify("Bearer tok")).toEqual({
      adminUserId: "admin_1",
      role: "SUPPORT_AGENT",
      mfa: false,
    });
  });

  it("rejects a token with no admin role (e.g. a plain user token)", () => {
    const v = new JwtAdminSessionVerifier(
      makeVerifier({ sub: "user_1", channel: "MOBILE" }),
    );
    expect(v.verify("Bearer tok")).toBeNull();
  });

  it("rejects a missing token and a signature failure", () => {
    const good = new JwtAdminSessionVerifier(
      makeVerifier({ sub: "a", adminRole: "SUPER_ADMIN", mfa: true }),
    );
    expect(good.verify(undefined)).toBeNull();

    const throwing = new JwtAdminSessionVerifier({
      verify: () => {
        throw new Error("bad signature");
      },
    });
    expect(throwing.verify("Bearer tok")).toBeNull();
  });
});

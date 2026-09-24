/**
 * Single-role RBAC for the admin console UI (R21.1–R21.5).
 *
 * This is the CLIENT-SIDE mirror of the server's authoritative permission
 * matrix in `apps/api/src/services/admin.ts` (`ADMIN_PERMISSIONS`). It exists
 * solely to hide/disable out-of-role affordances so the operator never sees a
 * control they cannot use. The server guard remains the source of truth: every
 * request is independently checked and an out-of-role attempt is rejected `403`
 * and recorded as a SECURITY_VIOLATION in the append-only Admin_Audit_Ledger
 * (R21.5). If this mirror ever drifts, the worst case is a disabled/hidden
 * control — never an unauthorized action.
 *
 * IMPORTANT: keep this map in lock-step with the server's `ADMIN_PERMISSIONS`.
 */
import type { AdminRole } from "@kshema/types";

/**
 * One capability per admin route (or a tightly-related pair), matching the
 * server's `AdminCapability` union exactly.
 */
export type AdminCapability =
  | "FLEET_PULSE_VIEW"
  | "CARRIER_HEALTH_VIEW"
  | "LIVE_INCIDENTS_VIEW"
  | "RETRY_DISPATCH"
  | "SUBSCRIPTIONS_VIEW"
  | "TRIAL_EXTENSION"
  | "PURGE_REQUEST"
  | "WAKEFULNESS_TEST"
  | "WEBHOOK_ERROR_QUEUE_VIEW";

/**
 * The permission matrix — a byte-for-byte mirror of the server's
 * `ADMIN_PERMISSIONS`. A capability is permitted for a role IFF the role
 * appears in that capability's set.
 *
 *   - SUPPORT_AGENT: read User metadata, search Circles, inspect delivery logs,
 *     trigger manual WhatsApp/IVR retries (fleet/carrier/live-incident views +
 *     retry dispatch + wakefulness test).
 *   - BILLING_OPS: view subscription statuses, modify Trial_Periods, issue Pro
 *     overrides, inspect payment webhooks (subscriptions + trial extension +
 *     webhook error queue).
 *   - SUPER_ADMIN: the superset — every capability, incl. DPDP/GDPR purge.
 */
export const ADMIN_PERMISSIONS: Readonly<
  Record<AdminCapability, ReadonlyArray<AdminRole>>
> = {
  FLEET_PULSE_VIEW: ["SUPER_ADMIN", "SUPPORT_AGENT"],
  CARRIER_HEALTH_VIEW: ["SUPER_ADMIN", "SUPPORT_AGENT"],
  LIVE_INCIDENTS_VIEW: ["SUPER_ADMIN", "SUPPORT_AGENT"],
  RETRY_DISPATCH: ["SUPER_ADMIN", "SUPPORT_AGENT"],
  SUBSCRIPTIONS_VIEW: ["SUPER_ADMIN", "BILLING_OPS"],
  TRIAL_EXTENSION: ["SUPER_ADMIN", "BILLING_OPS"],
  PURGE_REQUEST: ["SUPER_ADMIN"],
  WAKEFULNESS_TEST: ["SUPER_ADMIN", "SUPPORT_AGENT"],
  WEBHOOK_ERROR_QUEUE_VIEW: ["SUPER_ADMIN", "BILLING_OPS"],
} as const;

/** PURE RBAC test: is `capability` permitted for `role`? Mirrors the server. */
export function isPermitted(
  role: AdminRole,
  capability: AdminCapability,
): boolean {
  return ADMIN_PERMISSIONS[capability].includes(role);
}

/** A navigable console section, gated by the capability that backs its view. */
export interface ConsoleSection {
  readonly href: string;
  readonly label: string;
  readonly capability: AdminCapability;
}

/**
 * The console navigation. Each section maps to the capability that gates its
 * primary read; sections the current role cannot use are hidden from the nav
 * (they mirror the server guard). Copy is Brand_Lexicon — calm, operational,
 * never alarm-style.
 */
export const CONSOLE_SECTIONS: ReadonlyArray<ConsoleSection> = [
  { href: "/fleet", label: "Fleet Pulse", capability: "FLEET_PULSE_VIEW" },
  { href: "/carriers", label: "Carrier Health", capability: "CARRIER_HEALTH_VIEW" },
  { href: "/incidents", label: "Live Incidents", capability: "LIVE_INCIDENTS_VIEW" },
  { href: "/subscriptions", label: "Subscriptions", capability: "SUBSCRIPTIONS_VIEW" },
  { href: "/webhooks", label: "Webhook Queue", capability: "WEBHOOK_ERROR_QUEUE_VIEW" },
  { href: "/devices", label: "Device Wakefulness", capability: "WAKEFULNESS_TEST" },
  { href: "/purge", label: "Data Purge Requests", capability: "PURGE_REQUEST" },
] as const;

/** The sections visible to a given role (out-of-role sections hidden). */
export function visibleSections(role: AdminRole): ReadonlyArray<ConsoleSection> {
  return CONSOLE_SECTIONS.filter((s) => isPermitted(role, s.capability));
}

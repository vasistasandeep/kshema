/**
 * Admin console service layer (task 19.1 — R21).
 *
 * This module holds the *pure* and *seam* pieces of the Admin console so the
 * route module (`routes/admin.ts`) stays a thin HTTP shell and the security
 * rules are unit- and property-testable in isolation (design Property 17):
 *
 *   1. `ADMIN_PERMISSIONS` + `isPermitted` — the PURE single-role RBAC matrix
 *      (R21.2-R21.4). Each admin capability maps to exactly the roles the
 *      requirements grant it. `isPermitted` performs NO I/O.
 *
 *   2. `maskPhone` — the PURE phone-masking rule (R21.8): every rendered phone
 *      number is reduced to its last 4 digits UNLESS an authorized SUPPORT_AGENT
 *      has an active Stage-4 triage session for that record.
 *
 *   3. `isTelemetryAtRisk` — the PURE "3 missed heartbeats / 45 minutes of
 *      silence during active hours" flag (R21.16).
 *
 *   4. `computeCarrierErrorRate` + `CARRIER_ALERT_THRESHOLD` — the PURE rolling
 *      15-minute error-rate computation and the >5% on-call trip test (R21.14).
 *
 *   5. `OnCallAlerter` — the injectable SEAM a tripped carrier alert is routed
 *      to (R21.14). Default is in-memory so the route is exercised end-to-end
 *      without a live pager integration.
 *
 *   6. `AdminSessionVerifier` + `AdminSession` — the injectable MFA/RBAC
 *      identity SEAM behind `AdminAuthGuard`. The default `JwtAdminSession
 *      Verifier` reads a signed admin token (carrying the admin id, the single
 *      role, and an `mfa` claim); the guard rejects any token whose MFA claim
 *      is not satisfied (R21.1) and loads/uses the single role for RBAC.
 *
 * PRIVACY INVIOLABILITY (R21.6, R21.7): there is deliberately NO capability in
 * this module (or the routes that use it) to decrypt an Encrypted_Black_Box or
 * to initiate live GPS polling / continuous location traces / raw audio. No
 * such field or method is declared, so the admin surface structurally cannot
 * expose one.
 */
import type { AdminRole } from "@kshema/types";

// ---------------------------------------------------------------------------
// 1. Single-role RBAC matrix (R21.2, R21.3, R21.4, R21.5).
// ---------------------------------------------------------------------------

/**
 * The admin capabilities this task exposes. Each corresponds to one route (or
 * a tightly-related pair) so RBAC is decided per capability, not per HTTP verb.
 */
export type AdminCapability =
  /** View aggregated fleet telemetry pulse (R21.15, R21.16). */
  | "FLEET_PULSE_VIEW"
  /** View carrier gateway health (R21.13). */
  | "CARRIER_HEALTH_VIEW"
  /** View the live incident ops monitor (R21.10, R21.11). */
  | "LIVE_INCIDENTS_VIEW"
  /** Manually trigger an alternate carrier fallback dispatch (R21.12). */
  | "RETRY_DISPATCH"
  /** View subscription statuses (R21.3). */
  | "SUBSCRIPTIONS_VIEW"
  /** Grant a trial extension / SHIELD_PAUSED -> TRIAL restore (R21.3, R21.19). */
  | "TRIAL_EXTENSION"
  /** Schedule a DPDP/GDPR cryptographic purge (R21.21). */
  | "PURGE_REQUEST"
  /** Send a silent device wakefulness-test ping (R21.18). */
  | "WAKEFULNESS_TEST"
  /** Inspect the failed-payment webhook error queue (R21.3, R21.20). */
  | "WEBHOOK_ERROR_QUEUE_VIEW";

/**
 * The PURE permission matrix. A capability is permitted for a role IFF the role
 * appears in that capability's set. Derived directly from R21.2-R21.4:
 *
 *   - SUPPORT_AGENT: read User metadata, search Circles, inspect delivery logs,
 *     trigger manual WhatsApp/IVR retries (fleet/carrier/live-incident views +
 *     retry dispatch + wakefulness test).
 *   - BILLING_OPS: view subscription statuses, modify Trial_Periods, issue Pro
 *     overrides, inspect payment webhooks (subscriptions view + trial extension
 *     + webhook error queue).
 *   - SUPER_ADMIN: system configuration, credentials, admin user management —
 *     the superset; granted every capability here.
 */
export const ADMIN_PERMISSIONS: Readonly<
  Record<AdminCapability, ReadonlySet<AdminRole>>
> = {
  FLEET_PULSE_VIEW: new Set(["SUPER_ADMIN", "SUPPORT_AGENT"]),
  CARRIER_HEALTH_VIEW: new Set(["SUPER_ADMIN", "SUPPORT_AGENT"]),
  LIVE_INCIDENTS_VIEW: new Set(["SUPER_ADMIN", "SUPPORT_AGENT"]),
  RETRY_DISPATCH: new Set(["SUPER_ADMIN", "SUPPORT_AGENT"]),
  SUBSCRIPTIONS_VIEW: new Set(["SUPER_ADMIN", "BILLING_OPS"]),
  TRIAL_EXTENSION: new Set(["SUPER_ADMIN", "BILLING_OPS"]),
  PURGE_REQUEST: new Set(["SUPER_ADMIN"]),
  WAKEFULNESS_TEST: new Set(["SUPER_ADMIN", "SUPPORT_AGENT"]),
  WEBHOOK_ERROR_QUEUE_VIEW: new Set(["SUPER_ADMIN", "BILLING_OPS"]),
} as const;

/** PURE RBAC test: is `capability` permitted for `role`? (R21.2-R21.5). */
export function isPermitted(
  role: AdminRole,
  capability: AdminCapability,
): boolean {
  return ADMIN_PERMISSIONS[capability].has(role);
}

// ---------------------------------------------------------------------------
// 2. Phone masking (R21.8).
// ---------------------------------------------------------------------------

/**
 * PURE phone-masking rule (R21.8). By default every phone number is reduced to
 * its last 4 digits (leading digits replaced by the bullet character), so no
 * full number is rendered on an admin surface. The ONLY exception is an active
 * Stage-4 hyperlocal-dispatch triage session opened by an authorized
 * SUPPORT_AGENT — in that narrow case the full number is returned so the agent
 * can coordinate the emergency.
 *
 * A number with 4 or fewer visible digits is returned unmasked-length but the
 * non-digit prefix is still hidden; masking never lengthens the string.
 */
export function maskPhone(
  phone: string,
  opts: { activeStage4Triage?: boolean } = {},
): string {
  if (opts.activeStage4Triage === true) {
    return phone;
  }
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  const hiddenCount = Math.max(digits.length - last4.length, 0);
  return `${"•".repeat(hiddenCount)}${last4}`;
}

// ---------------------------------------------------------------------------
// 3. Telemetry-at-risk flag (R21.16).
// ---------------------------------------------------------------------------

/** 3 consecutive missed heartbeats == 45 minutes of silence (R21.16). */
export const TELEMETRY_AT_RISK_SILENCE_MS = 45 * 60 * 1000;

/**
 * PURE flag: an Anchor device is "Telemetry At Risk" when it has been silent
 * for at least 45 minutes (3 missed 15-minute heartbeats) as of `now` (R21.16).
 * A device with no recorded sync time has never checked in and is at risk.
 */
export function isTelemetryAtRisk(
  lastTelemetrySyncAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!lastTelemetrySyncAt) return true;
  return now.getTime() - lastTelemetrySyncAt.getTime() >= TELEMETRY_AT_RISK_SILENCE_MS;
}

// ---------------------------------------------------------------------------
// 4. Carrier error-rate on-call trip (R21.14).
// ---------------------------------------------------------------------------

/** 5% carrier error rate over a rolling 15-minute window trips the alert (R21.14). */
export const CARRIER_ALERT_THRESHOLD = 0.05;
/** The rolling window the error rate is measured over (R21.14). */
export const CARRIER_ALERT_WINDOW_MS = 15 * 60 * 1000;

/**
 * PURE: does `errorRate` (a fraction in [0,1]) STRICTLY exceed the 5% on-call
 * threshold? (R21.14). Equality (exactly 5%) does NOT trip the alert; the
 * requirement fires when the rate "exceeds 5 percent".
 */
export function exceedsCarrierAlertThreshold(errorRate: number): boolean {
  return errorRate > CARRIER_ALERT_THRESHOLD;
}

/**
 * PURE rolling error-rate computation. Given the failed and total dispatch
 * counts observed within the 15-minute window, returns the error-rate fraction.
 * A window with zero dispatches has a 0 error rate (no signal, no alert).
 */
export function computeCarrierErrorRate(failed: number, total: number): number {
  if (total <= 0) return 0;
  return failed / total;
}

/** A tripped carrier on-call alert routed to the engineering pager (R21.14). */
export interface OnCallAlert {
  gateway: string;
  errorRate: number;
  /** Start of the 15-minute rolling window the rate was measured over. */
  windowStart: string;
  /** When the alert tripped (ISO-8601). */
  firedAt: string;
}

/**
 * Injectable SEAM for firing a high-priority on-call alert (R21.14). The route
 * computes the rolling error rate and, when it exceeds 5%, hands the alert
 * here. Default is in-memory so the pipeline is exercised end-to-end without a
 * live pager; a durable/pager-backed alerter implements the same interface.
 */
export interface OnCallAlerter {
  fire(alert: OnCallAlert): Promise<void>;
}

/** Default in-memory alerter. Exposes `alerts` for assertions/dev inspection. */
export class InMemoryOnCallAlerter implements OnCallAlerter {
  readonly alerts: OnCallAlert[] = [];
  async fire(alert: OnCallAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

// ---------------------------------------------------------------------------
// 5. Device wakefulness-test push seam (R21.18).
// ---------------------------------------------------------------------------

/**
 * Injectable SEAM for the silent high-priority push ping sent to an Anchor
 * device during a wakefulness test (R21.18). Default is in-memory; the live
 * adapter (FCM/APNs high-priority data-only push) implements the same
 * interface. The ping carries no user-visible payload and no location request.
 */
export interface WakefulnessPinger {
  ping(input: { deviceId: string; pushTokens: string[] }): Promise<void>;
}

/** Default in-memory pinger. Exposes `pings` for assertions/dev inspection. */
export class InMemoryWakefulnessPinger implements WakefulnessPinger {
  readonly pings: Array<{ deviceId: string; pushTokens: string[] }> = [];
  async ping(input: { deviceId: string; pushTokens: string[] }): Promise<void> {
    this.pings.push(input);
  }
}

// ---------------------------------------------------------------------------
// 5b. Cryptographic purge scheduling seam (R21.21).
// ---------------------------------------------------------------------------

/** 30-day grace before a scheduled cryptographic purge executes (R21.21). */
export const PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** A scheduled DPDP/GDPR cryptographic purge awaiting the 30-day grace (R21.21). */
export interface ScheduledPurge {
  userId: string;
  /** Admin who scheduled it (for the audit ledger cross-reference). */
  requestedByAdminId: string;
  justification: string;
  requestedAt: string;
  /** When the purge becomes eligible to execute (requestedAt + 30 days). */
  purgeAfter: string;
}

/**
 * Injectable SEAM the purge request is recorded in (R21.21). The actual
 * cryptographic purge (deleting personal profile info, telemetry logs, and
 * public keys) executes only AFTER the grace window elapses and is the concern
 * of a later worker/cron. There is no dedicated Prisma model yet, so the
 * default is in-memory; a durable store implements the same interface. The
 * purge deletes personal data — it never decrypts a black box (R21.6).
 */
export interface PurgeScheduler {
  schedule(purge: ScheduledPurge): Promise<void>;
}

/** Default in-memory purge scheduler. Exposes `scheduled` for assertions. */
export class InMemoryPurgeScheduler implements PurgeScheduler {
  readonly scheduled: ScheduledPurge[] = [];
  async schedule(purge: ScheduledPurge): Promise<void> {
    this.scheduled.push(purge);
  }
}

// ---------------------------------------------------------------------------
// 6. Admin session verification seam (MFA + single-role RBAC — R21.1).
// ---------------------------------------------------------------------------

/** The verified identity of an authenticated admin caller. */
export interface AdminSession {
  /** The AdminUser id (Prisma cuid). */
  adminUserId: string;
  /** The single Admin_Role assigned to this admin (R21.1). */
  role: AdminRole;
  /** Whether multi-factor authentication was satisfied for this session (R21.1). */
  mfa: boolean;
}

/**
 * Injectable SEAM that turns a raw bearer token into an `AdminSession`, or
 * `null` when the token is absent/invalid. Kept as a seam so the guard is
 * testable without wiring real JWT signing, and so a future SSO/SAML admin IdP
 * can slot in behind the same interface.
 */
export interface AdminSessionVerifier {
  verify(bearerToken: string | undefined): AdminSession | null;
}

/** Minimal JWT verify surface (matches `@fastify/jwt`'s `app.jwt`). */
export interface JwtVerifier {
  verify<T = unknown>(token: string): T;
}

/**
 * Default admin session verifier: reads a signed admin JWT via the app's JWT
 * verifier. The token payload must carry `sub` (admin id), `adminRole` (one of
 * the three roles), and `mfa: true`. A token missing any of these — or one that
 * fails signature verification — yields `null`, so the guard denies. Ordinary
 * *user* access tokens (which carry no `adminRole`) also yield `null`, so a
 * user token can never be replayed against the admin surface.
 */
export class JwtAdminSessionVerifier implements AdminSessionVerifier {
  private static readonly ROLES: ReadonlySet<AdminRole> = new Set([
    "SUPER_ADMIN",
    "SUPPORT_AGENT",
    "BILLING_OPS",
  ]);

  constructor(private readonly jwt: JwtVerifier) {}

  verify(bearerToken: string | undefined): AdminSession | null {
    if (!bearerToken) return null;
    const token = bearerToken.startsWith("Bearer ")
      ? bearerToken.slice("Bearer ".length).trim()
      : bearerToken.trim();
    if (!token) return null;

    let payload: {
      sub?: unknown;
      adminRole?: unknown;
      mfa?: unknown;
    };
    try {
      payload = this.jwt.verify(token);
    } catch {
      return null;
    }

    const adminUserId = typeof payload.sub === "string" ? payload.sub : "";
    const role = payload.adminRole;
    const mfa = payload.mfa === true;
    if (
      !adminUserId ||
      typeof role !== "string" ||
      !JwtAdminSessionVerifier.ROLES.has(role as AdminRole)
    ) {
      return null;
    }
    return { adminUserId, role: role as AdminRole, mfa };
  }
}

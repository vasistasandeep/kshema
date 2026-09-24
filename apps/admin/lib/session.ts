/**
 * Admin console browser session (R21.1).
 *
 * The admin operator authenticates through the organisation's MFA/SSO flow,
 * which mints a signed admin JWT carrying `sub` (admin id), `adminRole` (one of
 * SUPER_ADMIN / SUPPORT_AGENT / BILLING_OPS), and `mfa: true`. The console holds
 * that bearer token for the tab and decodes its (unverified) payload purely to
 * drive UI gating — the Fastify `AdminAuthGuard` independently verifies the
 * signature and MFA claim on every request, so the client decode is advisory
 * only and can never grant access on its own.
 *
 * The token is kept in memory and mirrored to `sessionStorage` so the console
 * survives a soft reload but clears when the tab closes.
 */
import { AdminRoleSchema, type AdminRole } from "@kshema/types";

const STORAGE_KEY = "kshema.admin.session";

/** The identity the console derives from the admin token for UI gating. */
export interface AdminSession {
  /** Raw bearer token, sent verbatim as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Admin id (JWT `sub`). */
  readonly adminUserId: string;
  /** The single admin role (JWT `adminRole`). */
  readonly role: AdminRole;
  /** Whether the token asserts MFA was satisfied (JWT `mfa`). */
  readonly mfa: boolean;
}

let cached: AdminSession | null = null;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** URL-safe base64 decode of a JWT segment (browser + Node). */
function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  if (typeof atob === "function") {
    return decodeURIComponent(
      atob(padded)
        .split("")
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
  }
  // Node fallback (tests run under Node's vitest environment).
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Decode an admin JWT's claims for UI gating (advisory only — NOT verification).
 * Returns `null` when the token is malformed, carries no valid `adminRole`, or
 * has expired (`exp`). The server remains authoritative on signature + MFA.
 */
export function decodeAdminToken(
  token: string,
  now: number = Date.now(),
): AdminSession | null {
  const trimmed = token.trim().replace(/^Bearer\s+/i, "");
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(base64UrlDecode(parts[1]!)) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Respect token expiry when present (`exp` is seconds since epoch).
  if (typeof claims.exp === "number" && claims.exp * 1000 <= now) {
    return null;
  }

  const adminUserId = typeof claims.sub === "string" ? claims.sub : "";
  const parsedRole = AdminRoleSchema.safeParse(claims.adminRole);
  if (!adminUserId || !parsedRole.success) return null;

  return {
    token: trimmed,
    adminUserId,
    role: parsedRole.data,
    mfa: claims.mfa === true,
  };
}

/** Persist the admin session for this browser tab. */
export function setSession(session: AdminSession): void {
  cached = session;
  if (hasWindow()) {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
}

/** Read the current session, hydrating from `sessionStorage` on first call. */
export function getSession(): AdminSession | null {
  if (cached) return cached;
  if (!hasWindow()) return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    cached = JSON.parse(raw) as AdminSession;
    return cached;
  } catch {
    return null;
  }
}

/** Current bearer token, or `null` when signed out. */
export function getAccessToken(): string | null {
  return getSession()?.token ?? null;
}

/** Clear the admin session (sign out). */
export function clearSession(): void {
  cached = null;
  if (hasWindow()) {
    window.sessionStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * True when a usable admin session exists. The console additionally requires
 * the MFA claim to be satisfied before rendering any privileged view (R21.1);
 * a non-MFA token would be rejected by the server anyway.
 */
export function isAuthenticated(): boolean {
  const s = getSession();
  return s !== null && s.mfa;
}

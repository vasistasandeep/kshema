/**
 * Browser session store for the Observer web portal.
 *
 * Holds the JWT access/refresh tokens issued after a successful web OTP or
 * WebAuthn assertion (R28.1). The session is kept in memory and mirrored to
 * `sessionStorage` so a pinned Ambient Desk Mode tab survives a soft reload
 * but is cleared when the tab/window closes. The Observer PRIVATE key is NOT
 * part of the session — it lives only inside the Web_Crypto_Vault and never
 * transits (R28.2).
 */
import type { WebAuthSession } from "@kshema/types";

const STORAGE_KEY = "kshema.web.session";

let cached: WebAuthSession | null = null;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** Persist the session for this browser tab. */
export function setSession(session: WebAuthSession): void {
  cached = session;
  if (hasWindow()) {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
}

/** Read the current session, hydrating from `sessionStorage` on first call. */
export function getSession(): WebAuthSession | null {
  if (cached) return cached;
  if (!hasWindow()) return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    cached = JSON.parse(raw) as WebAuthSession;
    return cached;
  } catch {
    return null;
  }
}

/** Current bearer access token, or `null` when logged out. */
export function getAccessToken(): string | null {
  return getSession()?.accessToken ?? null;
}

/** Clear the session (logout or idle lock). Does not touch the vault. */
export function clearSession(): void {
  cached = null;
  if (hasWindow()) {
    window.sessionStorage.removeItem(STORAGE_KEY);
  }
}

/** True when a non-expired session exists. */
export function isAuthenticated(now: number = Date.now()): boolean {
  const session = getSession();
  if (!session) return false;
  return new Date(session.expiresAt).getTime() > now;
}

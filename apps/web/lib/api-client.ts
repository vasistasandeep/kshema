/**
 * Thin typed fetch wrapper around the Fastify API (`apps/api`).
 *
 * Every call targets the persistent service directly over CORS (R28.5). The
 * bearer access token from the in-memory session is attached automatically;
 * the Observer private key is NEVER sent — request bodies here only ever carry
 * public-key material or non-secret payloads (R28.2).
 */
import type {
  BillingIntervalSwitch,
  BillingPortalSessionResponse,
  BillingSummary,
  BlackBoxCiphertext,
  DashboardSnapshot,
  InvoiceListResponse,
  ResolveIncident,
  VitalityRhythmResponse,
  VoiceNoteArchiveResponse,
  WebAuthSession,
  WebOtpVerify,
} from "@kshema/types";
import { API_BASE_URL } from "./config";
import { getAccessToken } from "./session";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Skip the bearer header (used for the pre-login OTP endpoints). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.anonymous) {
    const token = getAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const payload = (await res.json()) as { message?: string };
      if (payload?.message) message = payload.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ---------------------------------------------------------------- auth ----- */

export function requestOtp(phone: string): Promise<{ challengeId: string }> {
  return request("/web/auth/otp/request", {
    body: { phone },
    anonymous: true,
  });
}

export function verifyOtp(body: WebOtpVerify): Promise<WebAuthSession> {
  return request("/web/auth/otp/verify", { body, anonymous: true });
}

/* ------------------------------------------------------------- dashboard --- */

/** WebSocket-fallback snapshot (JSON) for a one-shot pull; SSE is preferred. */
export function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  return request("/web/dashboard/ws");
}

/**
 * Mark an escalating Anchor confirmed safe (R28.8). An authorized Observer
 * override resolves the active incident; the worker halts pending stages.
 */
export function markAnchorSafe(incidentId: string): Promise<unknown> {
  const body: ResolveIncident = { source: "OBSERVER_OVERRIDE" };
  return request(`/incidents/${encodeURIComponent(incidentId)}/resolve`, {
    body,
  });
}

/* --------------------------------------------------------------- vitality -- */

export function fetchVitalityRhythm(
  anchorId: string,
  days = 30,
): Promise<VitalityRhythmResponse> {
  const qs = new URLSearchParams({ days: String(days), anchorId });
  return request(`/web/vitality/rhythm?${qs.toString()}`);
}

export function fetchVoiceNotes(
  anchorId: string,
): Promise<VoiceNoteArchiveResponse> {
  const qs = new URLSearchParams({ anchorId });
  return request(`/web/vitality/voice-notes?${qs.toString()}`);
}

/* --------------------------------------------------------------- billing --- */

export function fetchBillingSummary(): Promise<BillingSummary> {
  return request("/web/billing/summary");
}

export function fetchInvoices(): Promise<InvoiceListResponse> {
  return request("/web/billing/invoices");
}

export function openBillingPortal(): Promise<BillingPortalSessionResponse> {
  return request("/web/billing/portal-session", { body: {} });
}

export function switchBillingInterval(
  interval: BillingIntervalSwitch["interval"],
): Promise<unknown> {
  const body: BillingIntervalSwitch = { interval };
  return request("/web/billing/interval", { body });
}

/* ------------------------------------------------------------- black box --- */

/**
 * Fetch a RELEASED encrypted black box for in-browser decryption by the
 * Web_Crypto_Vault (R28.3). The API returns ciphertext only — it holds no
 * private key and never decrypts.
 */
export function fetchBlackBox(incidentId: string): Promise<BlackBoxCiphertext> {
  return request(`/incidents/${encodeURIComponent(incidentId)}/blackbox`, {
    body: {},
  });
}

/* ---------------------------------------------------------------- circles -- */

/**
 * Create an expiring invitation for a new Circle member (R28.12). Returns the
 * redeemable token + expiry the Observer shares with the invitee.
 */
export function createCircleInvitation(
  circleId: string,
  role?: "ANCHOR" | "OBSERVER" | "MUTUAL",
): Promise<{ inviteToken: string; expiresAt: string }> {
  return request(`/circles/${encodeURIComponent(circleId)}/invitations`, {
    body: role ? { role } : {},
  });
}

/**
 * Update a member's permission flags: authority to trigger Hyperlocal_Dispatch
 * and to access the Encrypted_Black_Box (R28.12). SUPER member only (enforced
 * server-side).
 */
export function updateMemberPermissions(
  circleId: string,
  memberId: string,
  flags: { canTriggerIVR?: boolean; canAccessBlackBox?: boolean },
): Promise<unknown> {
  return request(
    `/circles/${encodeURIComponent(circleId)}/members/${encodeURIComponent(
      memberId,
    )}`,
    { method: "PATCH", body: flags },
  );
}

export { request as rawRequest };

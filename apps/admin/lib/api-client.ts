/**
 * Thin typed fetch wrapper around the admin surface of the Fastify API
 * (`/api/v1/admin/*`, task 19.1 — R21).
 *
 * Every call targets the persistent service directly over CORS and attaches
 * the admin bearer token from the in-memory session. There is deliberately NO
 * method here that decrypts an Encrypted_Black_Box or polls live GPS/audio —
 * no such route exists on the server and none is surfaced here (R21.6, R21.7).
 * Phone numbers arrive already masked to the last 4 digits from the server
 * (R21.8); the console renders them verbatim.
 */
import type {
  CarrierHealth,
  FleetPulse,
  LiveIncident,
  AdminSubscriptionRow,
  WebhookErrorItem,
  RetryDispatch,
  RetryDispatchAck,
  TrialExtension,
  TrialExtensionResult,
  PurgeRequest,
  PurgeRequestAck,
  WakefulnessTest,
  WakefulnessTestAck,
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
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Optional justification note recorded in the Admin_Audit_Ledger (R21.9). */
  justification?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

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

/** Append `?justification=` to a read path when the operator supplied one. */
function withJustification(path: string, justification?: string): string {
  if (!justification || justification.trim().length === 0) return path;
  const qs = new URLSearchParams({ justification: justification.trim() });
  return `${path}?${qs.toString()}`;
}

/* ---------------------------------------------------------------- reads ---- */

/** Fleet telemetry pulse: active circles, telemetry-at-risk, open incidents. */
export function fetchFleetPulse(
  justification?: string,
  signal?: AbortSignal,
): Promise<FleetPulse> {
  return request(withJustification("/admin/fleet/pulse", justification), {
    ...(signal ? { signal } : {}),
  });
}

/** Carrier gateway health rows (WhatsApp/SMS/IVR delivery + error rate). */
export function fetchCarrierHealth(
  justification?: string,
  signal?: AbortSignal,
): Promise<CarrierHealth[]> {
  return request(withJustification("/admin/carrier/health", justification), {
    ...(signal ? { signal } : {}),
  });
}

/** Live active incidents across all four escalation stages (R21.10). */
export function fetchLiveIncidents(
  signal?: AbortSignal,
): Promise<LiveIncident[]> {
  return request("/admin/incidents/live", {
    ...(signal ? { signal } : {}),
  });
}

/** Subscription statuses across circles (R21.3). */
export function fetchSubscriptions(
  justification?: string,
  signal?: AbortSignal,
): Promise<AdminSubscriptionRow[]> {
  return request(withJustification("/admin/subscriptions", justification), {
    ...(signal ? { signal } : {}),
  });
}

/** Failed subscription/payment webhooks awaiting inspect/edit/re-drive (R21.20). */
export function fetchWebhookErrorQueue(
  justification?: string,
  signal?: AbortSignal,
): Promise<WebhookErrorItem[]> {
  return request(
    withJustification("/admin/webhooks/error-queue", justification),
    { ...(signal ? { signal } : {}) },
  );
}

/* -------------------------------------------------------------- mutations -- */

/** Manually trigger an alternate carrier fallback dispatch (R21.12). */
export function retryDispatch(
  incidentId: string,
  justification?: string,
): Promise<RetryDispatchAck> {
  const body: RetryDispatch = justification ? { justification } : {};
  return request(
    `/admin/incidents/${encodeURIComponent(incidentId)}/retry-dispatch`,
    { method: "POST", body },
  );
}

/** Grant a trial extension; restores SHIELD_PAUSED -> TRIAL (R21.19). */
export function extendTrial(
  circleId: string,
  additionalDays: number,
  justification: string,
): Promise<TrialExtensionResult> {
  const body: TrialExtension = { additionalDays, justification };
  return request(`/admin/circles/${encodeURIComponent(circleId)}/trial`, {
    method: "PATCH",
    body,
  });
}

/** Schedule a DPDP/GDPR cryptographic purge with a 30-day grace (R21.21). */
export function requestPurge(
  userId: string,
  justification: string,
): Promise<PurgeRequestAck> {
  const body: PurgeRequest = { justification };
  return request(`/admin/users/${encodeURIComponent(userId)}/purge-request`, {
    method: "POST",
    body,
  });
}

/** Send a silent high-priority wakefulness-test push ping to a device (R21.18). */
export function wakefulnessTest(
  deviceId: string,
  justification?: string,
): Promise<WakefulnessTestAck> {
  const body: WakefulnessTest = justification ? { justification } : {};
  return request(
    `/admin/devices/${encodeURIComponent(deviceId)}/wakefulness-test`,
    { method: "POST", body },
  );
}

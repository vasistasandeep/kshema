/**
 * Emergency responder-portal API client (R29).
 *
 * Thin, dependency-light wrapper over the two zero-login, token-gated routes
 * implemented in `apps/api` task 13.3:
 *
 *   - `GET  /api/v1/emergency/:token`          → read-only triage payload
 *   - `POST /api/v1/emergency/:token/confirm`  → responder confirms safe
 *
 * The signed `Emergency_Access_Token` carried in the URL is the SOLE credential
 * (R29.4); this client never attaches a bearer token, cookie, or any private
 * key. Both routes answer `200` with the expected DTO or a `410`-style
 * "concluded" body for invalid/expired/invalidated tokens (R29.11) — the client
 * folds both into a discriminated union so the UI renders the right surface
 * without ever branching on raw status codes.
 *
 * Responses are validated against the `@kshema/types` Zod schemas so the portal
 * can never render a payload that structurally violates the exclusion contract
 * (no location/financial/chat — R29.7); `.strict()` on those schemas rejects any
 * unexpected field.
 */
import {
  ResponderTriagePayloadSchema,
  TokenConcludedSchema,
  type ResponderTriagePayload,
  type TokenConcluded,
} from "@kshema/types";

/** A successful triage load: the API returned a valid read-only card (R29.6). */
export interface TriageResult {
  readonly kind: "triage";
  readonly payload: ResponderTriagePayload;
}

/**
 * The token is invalid, expired, or already invalidated — render the
 * informational "the safety check has concluded" screen (R29.11). We also fold
 * network/parse failures into this state so a responder never sees a raw error;
 * `reason` is for diagnostics/telemetry only and is never surfaced to the user.
 */
export interface ConcludedResult {
  readonly kind: "concluded";
  readonly body: TokenConcluded;
  readonly reason?: "expired-or-invalid" | "network" | "unexpected";
}

export type EmergencyLoadResult = TriageResult | ConcludedResult;

/** The generic "concluded" body used when the API is unreachable or unparsable. */
const FALLBACK_CONCLUDED: TokenConcluded = {
  concluded: true,
  message: "This safety check has concluded.",
};

/**
 * Resolve the configured `apps/api` base URL. Set `KSHEMA_API_BASE_URL` in the
 * deployment environment (see `next.config.mjs`). Kept as a function so the
 * value is read at request time on the edge rather than baked at import.
 */
function apiBaseUrl(): string {
  const base = process.env.KSHEMA_API_BASE_URL ?? "";
  return base.replace(/\/+$/, "");
}

/** Build the versioned emergency endpoint for a given raw token. */
function emergencyUrl(token: string, suffix = ""): string {
  return `${apiBaseUrl()}/api/v1/emergency/${encodeURIComponent(token)}${suffix}`;
}

/**
 * Load the read-only triage payload for a token (R29.6). Never throws: any
 * failure (410, network, malformed body) collapses into a `concluded` result so
 * the edge page always has something safe to render.
 */
export async function loadTriage(token: string): Promise<EmergencyLoadResult> {
  let response: Response;
  try {
    response = await fetch(emergencyUrl(token), {
      method: "GET",
      headers: { accept: "application/json" },
      // The responder view must always reflect live incident state; never cache.
      cache: "no-store",
    });
  } catch {
    return { kind: "concluded", body: FALLBACK_CONCLUDED, reason: "network" };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: "concluded", body: FALLBACK_CONCLUDED, reason: "unexpected" };
  }

  if (response.ok) {
    const parsed = ResponderTriagePayloadSchema.safeParse(json);
    if (parsed.success) {
      return { kind: "triage", payload: parsed.data };
    }
    // A 200 that fails the strict schema is treated as concluded rather than
    // rendering an unverified payload.
    return { kind: "concluded", body: FALLBACK_CONCLUDED, reason: "unexpected" };
  }

  // Non-2xx: expect the "concluded" body (410). Fall back to the generic one.
  const concluded = TokenConcludedSchema.safeParse(json);
  return {
    kind: "concluded",
    body: concluded.success ? concluded.data : FALLBACK_CONCLUDED,
    reason: "expired-or-invalid",
  };
}

/** Outcome of a responder confirmation tap (R29.8, R29.9). */
export interface ConfirmResult {
  /** `true` once the API acknowledged the confirmation (Observers notified). */
  readonly ok: boolean;
  /** The message to show the responder (from the API, or a safe fallback). */
  readonly message: string;
}

/**
 * Submit a responder confirmation (R29.8, R29.9). The API resolves the incident
 * with `RESPONDER_CONFIRMED`, notifies Observers, and invalidates the token
 * (R29.10). Both `200` and `410` carry a `TokenConcluded` body — either way the
 * safety check is over, so both are surfaced as a completed outcome; only a
 * genuine transport failure is reported as not-ok so the UI can invite a retry.
 */
export async function confirmSafe(
  token: string,
  responderName: string,
): Promise<ConfirmResult> {
  let response: Response;
  try {
    response = await fetch(emergencyUrl(token, "/confirm"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ responderName }),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      message: "We couldn't reach the network. Please try again.",
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }

  const parsed = TokenConcludedSchema.safeParse(json);
  const message = parsed.success
    ? parsed.data.message
    : "Thank you. The Circle has been notified.";

  // A 200 (fresh confirm) and a 410 (already concluded) both mean the safety
  // check is over from the responder's perspective.
  return { ok: true, message };
}

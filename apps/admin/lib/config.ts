/**
 * Runtime configuration for the admin operations console.
 *
 * The console talks ONLY to the persistent Fastify service (`apps/api`) over
 * CORS — never through a Next.js serverless route — so a long-lived live-incident
 * poll/stream is never severed by a serverless execution timeout, and no server
 * route here can proxy a privileged action (design "apps/admin — console").
 * The API origin is a public, browser-visible value (`NEXT_PUBLIC_*`).
 */

/** Absolute origin of the Fastify API, e.g. `https://api.kshema.app`. */
export const API_ORIGIN: string =
  process.env.NEXT_PUBLIC_KSHEMA_API_ORIGIN?.replace(/\/$/, "") ??
  "http://localhost:3000";

/** Versioned API prefix, matching the Fastify `/api/v1` mount. */
export const API_PREFIX = "/api/v1" as const;

/** Full base URL for versioned API calls. */
export const API_BASE_URL = `${API_ORIGIN}${API_PREFIX}` as const;

/**
 * Poll interval for the live incident ops monitor (R21.10). The design has the
 * console subscribe to a server-sent stream of active incidents; until that
 * dedicated admin SSE endpoint exists, the console refreshes `/admin/incidents/live`
 * on this cadence, which keeps the monitor "real-time" for triage purposes and
 * surfaces a dispatch-failure visual alarm as soon as the API reports it (R21.11).
 */
export const LIVE_INCIDENTS_POLL_MS = 5_000;

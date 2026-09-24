/**
 * Runtime configuration for the Observer web portal.
 *
 * The dashboard talks ONLY to the persistent Fastify service (`apps/api`) over
 * CORS — never through a Next.js serverless route — so a long-lived SSE
 * connection is never severed by a serverless execution timeout (design
 * "Observer web portal", R28.5, R28.9). The API origin is therefore a public,
 * browser-visible value (`NEXT_PUBLIC_*`).
 */

/** Absolute origin of the Fastify API, e.g. `https://api.kshema.app`. */
export const API_ORIGIN: string =
  process.env.NEXT_PUBLIC_KSHEMA_API_ORIGIN?.replace(/\/$/, "") ??
  "http://localhost:3000";

/** Versioned API prefix, matching the Fastify `/api/v1` mount. */
export const API_PREFIX = "/api/v1" as const;

/** Full base URL for versioned API calls. */
export const API_BASE_URL = `${API_ORIGIN}${API_PREFIX}` as const;

/** Idle window before the portal locks and requires re-auth (R28.4). */
export const IDLE_LOCK_MS = 30 * 60 * 1000;

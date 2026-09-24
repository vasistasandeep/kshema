/**
 * Ambient Desk Mode live stream client (R28.5, R28.9).
 *
 * Opens an `EventSource` DIRECTLY against the persistent Fastify service —
 * never a Next.js serverless route — so the long-lived SSE connection is never
 * severed by a serverless execution timeout (design "Observer web portal").
 * The server pushes `event: snapshot` frames carrying a `DashboardSnapshot`;
 * the client applies each frame in place, so telemetry refreshes silently with
 * NO manual page reload (R28.9).
 *
 * A browser `EventSource` cannot set an `Authorization` header, so the bearer
 * token is passed as the `?token=` query parameter the API accepts for exactly
 * this reason. On transient failure the browser's built-in `EventSource`
 * reconnection applies; a `?token=` refresh reopens after a token rotation.
 */
import type { DashboardSnapshot } from "@kshema/types";
import { API_BASE_URL } from "./config";

export interface DashboardStreamHandlers {
  onSnapshot: (snapshot: DashboardSnapshot) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
}

export interface DashboardStreamHandle {
  close: () => void;
}

/**
 * Open the dashboard SSE stream. Returns a handle whose `close()` tears down
 * the connection (call it on unmount / logout / idle lock).
 */
export function openDashboardStream(
  accessToken: string,
  handlers: DashboardStreamHandlers,
): DashboardStreamHandle {
  if (typeof EventSource === "undefined") {
    // No SSE in this environment (e.g. SSR). Hand back a no-op handle; the UI
    // falls back to the one-shot `/web/dashboard/ws` snapshot pull.
    handlers.onError?.(new Error("EventSource is unavailable."));
    return { close: () => undefined };
  }

  const url = `${API_BASE_URL}/web/dashboard/stream?token=${encodeURIComponent(
    accessToken,
  )}`;
  const source = new EventSource(url);

  source.addEventListener("open", () => handlers.onOpen?.());

  source.addEventListener("snapshot", (event) => {
    try {
      const data = (event as MessageEvent).data as string;
      handlers.onSnapshot(JSON.parse(data) as DashboardSnapshot);
    } catch (err) {
      handlers.onError?.(err);
    }
  });

  source.addEventListener("error", (err) => handlers.onError?.(err));

  return {
    close: () => source.close(),
  };
}

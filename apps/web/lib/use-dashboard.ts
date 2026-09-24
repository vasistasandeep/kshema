"use client";

/**
 * React hook that keeps an Ambient Desk Mode snapshot live (R28.5, R28.9).
 *
 * Opens the SSE stream against the persistent Fastify service and applies each
 * `snapshot` frame in place — no page reload. If SSE is unavailable it falls
 * back to a single `/web/dashboard/ws` JSON pull so the UI still renders.
 */
import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "@kshema/types";
import { fetchDashboardSnapshot } from "./api-client";
import { openDashboardStream } from "./dashboard-stream";
import { getAccessToken } from "./session";

export interface DashboardStreamStatus {
  snapshot: DashboardSnapshot | null;
  connected: boolean;
  error: string | null;
}

export function useDashboardStream(): DashboardStreamStatus {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      setError("Your session has ended. Please sign in again.");
      return;
    }

    // One-shot pull so the hero card paints immediately, then live updates.
    let cancelled = false;
    void fetchDashboardSnapshot()
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch(() => undefined);

    const handle = openDashboardStream(token, {
      onOpen: () => {
        setConnected(true);
        setError(null);
      },
      onSnapshot: (s) => setSnapshot(s),
      onError: () => {
        setConnected(false);
        // EventSource auto-reconnects; surface a gentle, non-alarming note.
        setError("Reconnecting to the live view…");
      },
    });

    return () => {
      cancelled = true;
      handle.close();
    };
  }, []);

  return { snapshot, connected, error };
}

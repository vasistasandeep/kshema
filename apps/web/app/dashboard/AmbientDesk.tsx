"use client";

/**
 * Ambient Desk Mode (R28.5-28.9). A persistent, pinned-tab view of every
 * Anchor the Observer watches. Telemetry refreshes silently over SSE with NO
 * manual reload; the dual-timezone clock and Sage/Amber hero come straight
 * from the live snapshot.
 */
import { useDashboardStream } from "../../lib/use-dashboard";
import { AnchorHeroCard } from "./AnchorHeroCard";

export function AmbientDesk(): JSX.Element {
  const { snapshot, connected, error } = useDashboardStream();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Ambient Desk</h1>
        <span
          className="text-xs text-typography/50"
          aria-live="polite"
        >
          {connected ? "Live" : (error ?? "Connecting…")}
        </span>
      </div>

      {!snapshot ? (
        <p className="text-typography/60">Bringing your Circle into view…</p>
      ) : snapshot.anchors.length === 0 ? (
        <p className="text-typography/60">
          No Anchors in your Circle yet. Invite someone from Circle Settings.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {snapshot.anchors.map((tick) => (
            <AnchorHeroCard key={tick.anchorId} tick={tick} />
          ))}
        </div>
      )}
    </div>
  );
}

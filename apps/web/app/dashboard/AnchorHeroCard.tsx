"use client";

/**
 * One Anchor's Ambient Desk Mode hero card (R28.6, R28.7, R28.8).
 *
 * Healthy → Sage "All Well" with the verified morning timestamp; escalating →
 * Amber with the active stage plus direct-action controls to place a voice
 * call and to mark the Anchor confirmed safe. Colors and copy come from the
 * pure `ambient-presentation` helpers, so no Banned_Term or clinical color can
 * slip in here.
 */
import { useState } from "react";
import type { DashboardTick } from "@kshema/types";
import { markAnchorSafe } from "../../lib/api-client";
import {
  formatDualClock,
  heroFor,
  lastConfirmedLabel,
} from "../../lib/ambient-presentation";

export function AnchorHeroCard({
  tick,
  incidentId,
  primaryObserverTel,
}: {
  tick: DashboardTick;
  /** Active incident id, present only while escalating (enables mark-safe). */
  incidentId?: string;
  /** `tel:` number for the one-tap voice call during escalation. */
  primaryObserverTel?: string;
}): JSX.Element {
  const hero = heroFor(tick);
  const clock = formatDualClock(tick);
  const confirmed = lastConfirmedLabel(tick);
  const [marking, setMarking] = useState(false);
  const [marked, setMarked] = useState(false);

  async function onMarkSafe(): Promise<void> {
    if (!incidentId) return;
    setMarking(true);
    try {
      await markAnchorSafe(incidentId);
      setMarked(true);
    } finally {
      setMarking(false);
    }
  }

  return (
    <section
      className={`rounded-2xl p-6 text-white shadow-sm ${hero.bgClass}`}
      aria-label={`${tick.preferredName}: ${hero.label}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm/none opacity-90">{tick.preferredName}</p>
          <h2 className="mt-1 text-2xl font-semibold">{hero.label}</h2>
          {confirmed ? (
            <p className="mt-2 text-sm opacity-90">{confirmed}</p>
          ) : null}
        </div>
        <div className="text-right text-sm opacity-95">
          <p>You: {clock.observerLabel}</p>
          <p>
            {tick.preferredName}: {clock.anchorLabel}
          </p>
          <p className="text-xs opacity-75">{clock.anchorTimezone}</p>
        </div>
      </div>

      {hero.showActions ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={primaryObserverTel ? `tel:${primaryObserverTel}` : undefined}
            aria-disabled={!primaryObserverTel}
            className="rounded-full bg-white px-5 py-2.5 font-medium text-escalating"
          >
            Place a voice call
          </a>
          <button
            type="button"
            onClick={onMarkSafe}
            disabled={!incidentId || marking || marked}
            className="rounded-full border border-white/70 px-5 py-2.5 font-medium text-white disabled:opacity-60"
          >
            {marked
              ? "Marked confirmed safe"
              : marking
                ? "Confirming…"
                : "Mark confirmed safe"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

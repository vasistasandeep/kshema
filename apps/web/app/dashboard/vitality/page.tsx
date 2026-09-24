"use client";

/**
 * Connection Rhythm — 30-day vitality history (R28.13, R28.14, R28.15).
 *
 * An interactive calendar of morning confirmation times, Sparsh interaction
 * counts, and step progression, plus archived micro-voice replies and
 * Vitality_Pulse cards. NO location breadcrumbs appear anywhere — the API DTO
 * structurally excludes them (R28.15) and this view surfaces only rhythm data.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  DashboardSnapshot,
  VitalityRhythmResponse,
  VoiceNoteArchiveResponse,
} from "@kshema/types";
import {
  fetchDashboardSnapshot,
  fetchVitalityRhythm,
  fetchVoiceNotes,
} from "../../../lib/api-client";

export default function VitalityPage(): JSX.Element {
  const [anchors, setAnchors] = useState<DashboardSnapshot["anchors"]>([]);
  const [anchorId, setAnchorId] = useState<string>("");
  const [rhythm, setRhythm] = useState<VitalityRhythmResponse | null>(null);
  const [voice, setVoice] = useState<VoiceNoteArchiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Discover which Anchors this Observer watches from the dashboard snapshot.
  useEffect(() => {
    void fetchDashboardSnapshot()
      .then((snap) => {
        setAnchors(snap.anchors);
        if (snap.anchors[0]) setAnchorId(snap.anchors[0].anchorId);
      })
      .catch(() => setError("Could not load your Circle."));
  }, []);

  useEffect(() => {
    if (!anchorId) return;
    setError(null);
    void fetchVitalityRhythm(anchorId, 30)
      .then(setRhythm)
      .catch(() => setError("Could not load the connection rhythm."));
    void fetchVoiceNotes(anchorId).then(setVoice).catch(() => undefined);
  }, [anchorId]);

  const anchorName = useMemo(
    () => anchors.find((a) => a.anchorId === anchorId)?.preferredName ?? "",
    [anchors, anchorId],
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Connection Rhythm</h1>
        {anchors.length > 1 ? (
          <select
            value={anchorId}
            onChange={(e) => setAnchorId(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-1.5"
            aria-label="Choose an Anchor"
          >
            {anchors.map((a) => (
              <option key={a.anchorId} value={a.anchorId}>
                {a.preferredName}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-primary-action">
          {error}
        </p>
      ) : null}

      <section aria-label="30-day connection rhythm">
        <h2 className="mb-3 text-sm font-medium text-typography/70">
          Last 30 mornings {anchorName ? `with ${anchorName}` : ""}
        </h2>
        <div className="grid grid-cols-7 gap-1.5">
          {(rhythm?.series ?? []).map((day) => {
            const confirmed = Boolean(day.morningConfirmationAt);
            return (
              <div
                key={day.date}
                title={`${day.date}${
                  confirmed ? " — confirmed" : ""
                } · ${day.sparshCount} Sparsh${
                  day.stepProgression != null
                    ? ` · ${day.stepProgression} steps`
                    : ""
                }`}
                className={`aspect-square rounded-md ${
                  confirmed ? "bg-healthy" : "bg-typography/10"
                }`}
              />
            );
          })}
        </div>
        {rhythm && rhythm.series.length === 0 ? (
          <p className="mt-3 text-sm text-typography/60">
            No rhythm recorded in this window yet.
          </p>
        ) : null}
      </section>

      <section aria-label="Micro-voice replies and Vitality Pulse cards">
        <h2 className="mb-3 text-sm font-medium text-typography/70">
          Voice notes &amp; Vitality Pulse
        </h2>
        <ul className="flex flex-col gap-2">
          {(voice?.entries ?? []).map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between rounded-lg border border-typography/10 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">
                  {entry.kind === "VOICE_NOTE"
                    ? "Micro-voice reply"
                    : "Vitality Pulse"}
                </p>
                <p className="text-xs text-typography/60">
                  {new Date(entry.recordedAt).toLocaleString()}
                </p>
              </div>
              {entry.kind === "VOICE_NOTE" && entry.audioRef ? (
                <audio
                  controls
                  src={entry.audioRef}
                  className="h-8"
                  aria-label="Play micro-voice reply"
                />
              ) : (
                <span className="text-xs text-typography/50">
                  {entry.preferredName ?? "—"}
                </span>
              )}
            </li>
          ))}
          {voice && voice.entries.length === 0 ? (
            <li className="text-sm text-typography/60">
              No voice notes archived yet.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}

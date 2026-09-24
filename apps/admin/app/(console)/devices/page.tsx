"use client";

/**
 * Device Wakefulness Test (R21.18). Sends a silent high-priority push ping to a
 * target Anchor device to verify the background agent is alive. Read-only in
 * effect (no user-visible notification on the device); the action is audited.
 */
import { useState } from "react";
import { ApiError, wakefulnessTest } from "../../../lib/api-client";
import {
  PageHeader,
  ErrorNote,
  SuccessNote,
} from "../../../components/ui";
import { RequireCapability } from "../../../components/RequireCapability";

export default function DevicesPage(): JSX.Element {
  return (
    <RequireCapability capability="WAKEFULNESS_TEST">
      <WakefulnessView />
    </RequireCapability>
  );
}

function WakefulnessView(): JSX.Element {
  const [deviceId, setDeviceId] = useState("");
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const ack = await wakefulnessTest(deviceId.trim(), justification.trim() || undefined);
      setNotice(`Silent wakefulness ping sent to device ${ack.deviceId}.`);
      setDeviceId("");
      setJustification("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the wakefulness ping.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Device Wakefulness Test"
        description="Send a silent, high-priority push ping to a specific Anchor device to confirm its background agent is responsive. The device shows no notification; your action is recorded in the audit ledger."
      />

      {notice ? <div className="mb-4"><SuccessNote message={notice} /></div> : null}
      {error ? <div className="mb-4"><ErrorNote message={error} /></div> : null}

      <form
        onSubmit={onSubmit}
        className="max-w-xl rounded-xl border border-typography/10 bg-white/40 p-5"
      >
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-typography/70">Device id</span>
          <input
            type="text"
            required
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2 font-mono text-xs"
            placeholder="dev_…"
          />
        </label>
        <label className="mt-4 flex flex-col text-sm">
          <span className="mb-1 text-typography/70">Justification (audited, optional)</span>
          <input
            type="text"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2"
            placeholder="e.g. Family reports missed morning check-ins"
          />
        </label>
        <button
          type="submit"
          disabled={busy || deviceId.trim().length === 0}
          className="mt-5 rounded-full bg-primary-action px-5 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send wakefulness ping"}
        </button>
      </form>
    </div>
  );
}

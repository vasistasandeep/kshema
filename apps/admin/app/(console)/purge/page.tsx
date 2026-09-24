"use client";

/**
 * Data Purge Requests (R21.21). Schedules a DPDP/GDPR cryptographic purge for a
 * User: personal profile information, telemetry logs, and public keys are
 * permanently deleted after a 30-day grace period. SUPER_ADMIN only (mirrors the
 * server RBAC). A justification is required and recorded in the audit ledger.
 *
 * This console cannot and does not touch Encrypted_Black_Box plaintext — the
 * purge operates on the server-held records only, never on content it could
 * never read in the first place (R21.6).
 */
import { useState } from "react";
import { ApiError, requestPurge } from "../../../lib/api-client";
import {
  PageHeader,
  ErrorNote,
  SuccessNote,
} from "../../../components/ui";
import { RequireCapability } from "../../../components/RequireCapability";

export default function PurgePage(): JSX.Element {
  return (
    <RequireCapability capability="PURGE_REQUEST">
      <PurgeView />
    </RequireCapability>
  );
}

function PurgeView(): JSX.Element {
  const [userId, setUserId] = useState("");
  const [justification, setJustification] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const ack = await requestPurge(userId.trim(), justification.trim());
      setNotice(
        `Purge scheduled for user ${ack.userId}. Personal data is permanently deleted after ${new Date(ack.purgeAfter).toLocaleDateString()}.`,
      );
      setUserId("");
      setJustification("");
      setConfirmed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not schedule the purge.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Data Purge Requests"
        description="Schedule a cryptographic purge under the DPDP Act or GDPR. The account's personal profile, telemetry logs, and public keys are permanently deleted after a 30-day grace period."
      />

      {notice ? <div className="mb-4"><SuccessNote message={notice} /></div> : null}
      {error ? <div className="mb-4"><ErrorNote message={error} /></div> : null}

      <form
        onSubmit={onSubmit}
        className="max-w-xl rounded-xl border border-typography/10 bg-white/40 p-5"
      >
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-typography/70">User id</span>
          <input
            type="text"
            required
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2 font-mono text-xs"
            placeholder="usr_…"
          />
        </label>
        <label className="mt-4 flex flex-col text-sm">
          <span className="mb-1 text-typography/70">Justification (audited)</span>
          <input
            type="text"
            required
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2"
            placeholder="e.g. Verified DPDP erasure request, ticket #12345"
          />
        </label>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1"
          />
          <span className="text-typography/70">
            I understand this schedules a permanent deletion after a 30-day grace
            period and cannot be undone once the grace period elapses.
          </span>
        </label>
        <button
          type="submit"
          disabled={busy || !confirmed || userId.trim().length === 0 || justification.trim().length === 0}
          className="mt-5 rounded-full bg-primary-action px-5 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Scheduling…" : "Schedule purge (30-day grace)"}
        </button>
      </form>
    </div>
  );
}

"use client";

/**
 * Subscriptions (R21.3, R21.19). Subscription statuses per Circle, with an
 * inline trial-extension action for authorized BILLING_OPS / SUPER_ADMIN that
 * restores a Circle from SHIELD_PAUSED back to TRIAL and pushes out the expiry.
 * A justification is required and recorded in the audit ledger (R21.9, R21.19).
 */
import { useCallback, useEffect, useState } from "react";
import type {
  AdminRole,
  AdminSubscriptionRow,
  SubscriptionTier,
} from "@kshema/types";
import {
  ApiError,
  extendTrial,
  fetchSubscriptions,
} from "../../../lib/api-client";
import { getSession } from "../../../lib/session";
import { isPermitted } from "../../../lib/rbac";
import {
  PageHeader,
  ErrorNote,
  SuccessNote,
  Loading,
} from "../../../components/ui";
import { DataGrid, type Column } from "../../../components/DataGrid";
import { RequireCapability } from "../../../components/RequireCapability";

const TIER_LABEL: Record<SubscriptionTier, string> = {
  TRIAL: "Trial",
  PRO: "Pro",
  SHIELD_PAUSED: "Shield Paused",
};

export default function SubscriptionsPage(): JSX.Element {
  return (
    <RequireCapability capability="SUBSCRIPTIONS_VIEW">
      <SubscriptionsView />
    </RequireCapability>
  );
}

function SubscriptionsView(): JSX.Element {
  const [rows, setRows] = useState<AdminSubscriptionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setRows(await fetchSubscriptions(undefined, signal));
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : "Could not load subscriptions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRole(getSession()?.role ?? null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const canExtend = role != null && isPermitted(role, "TRIAL_EXTENSION");

  async function onExtend(
    circleId: string,
    additionalDays: number,
    justification: string,
  ): Promise<void> {
    setNotice(null);
    setError(null);
    try {
      const result = await extendTrial(circleId, additionalDays, justification);
      setNotice(
        `Circle ${result.circleId}: ${TIER_LABEL[result.previousTier]} → ${TIER_LABEL[result.tier]}, trial now ends ${new Date(result.trialEndsAt).toLocaleDateString()}.`,
      );
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not extend the trial.");
    }
  }

  const columns: Column<AdminSubscriptionRow>[] = [
    {
      key: "circleId",
      header: "Circle",
      render: (r) => <span className="font-mono text-xs">{r.circleId}</span>,
    },
    {
      key: "tier",
      header: "Tier",
      render: (r) => (
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            r.tier === "SHIELD_PAUSED"
              ? "bg-escalating/20"
              : r.tier === "PRO"
                ? "bg-celebration/20"
                : "bg-healthy/20"
          }`}
        >
          {TIER_LABEL[r.tier]}
        </span>
      ),
    },
    {
      key: "trialEndsAt",
      header: "Trial ends",
      render: (r) => new Date(r.trialEndsAt).toLocaleDateString(),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        canExtend ? (
          <button
            type="button"
            onClick={() => setEditing(editing === r.circleId ? null : r.circleId)}
            className="rounded-full border border-primary-action/40 px-3 py-1 text-xs text-primary-action hover:bg-primary-action/5"
          >
            {editing === r.circleId ? "Cancel" : "Extend trial"}
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        description="Subscription status per Circle. Granting a trial extension restores a paused Circle to full protection and records your reason in the audit ledger."
      />

      {notice ? <div className="mb-4"><SuccessNote message={notice} /></div> : null}
      {error ? <div className="mb-4"><ErrorNote message={error} /></div> : null}

      {loading && rows.length === 0 ? (
        <Loading label="Loading subscriptions…" />
      ) : (
        <>
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.circleId}
            emptyLabel="No subscriptions to show."
          />
          {editing && canExtend ? (
            <TrialExtensionForm
              circleId={editing}
              onSubmit={onExtend}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function TrialExtensionForm({
  circleId,
  onSubmit,
  onCancel,
}: {
  circleId: string;
  onSubmit: (circleId: string, days: number, justification: string) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [days, setDays] = useState(14);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(circleId, days, justification.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 rounded-xl border border-typography/10 bg-white/40 p-5"
    >
      <h2 className="text-sm font-medium">
        Extend trial for <span className="font-mono">{circleId}</span>
      </h2>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-typography/70">Additional days</span>
          <input
            type="number"
            min={1}
            max={60}
            required
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-28 rounded-lg border border-typography/20 px-3 py-2"
          />
        </label>
        <label className="flex flex-1 flex-col text-sm">
          <span className="mb-1 text-typography/70">Justification (audited)</span>
          <input
            type="text"
            required
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2"
            placeholder="e.g. Payment retry in progress; extending goodwill window"
          />
        </label>
        <button
          type="submit"
          disabled={busy || justification.trim().length === 0}
          className="rounded-full bg-primary-action px-5 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Applying…" : "Apply extension"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-typography/60 hover:text-typography"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

"use client";

/**
 * Live Incident Ops (R21.10, R21.11, R21.12).
 *
 * A real-time monitor of every active Safety_Incident across all four stages.
 * The design has this view subscribe to a server-sent stream; until that
 * dedicated admin SSE endpoint exists, the console refreshes `/admin/incidents/live`
 * on a short cadence so the monitor stays current for triage. When the API
 * later exposes a dispatch-failure signal, the same row highlight + visual alarm
 * wiring here surfaces it (R21.11). Authorized SUPPORT_AGENT/SUPER_ADMIN can
 * trigger a manual alternate-carrier fallback dispatch per incident (R21.12).
 *
 * Anchor phone numbers arrive masked to the last 4 digits from the server
 * (R21.8) — this list view never opens a Stage-4 triage session, so masking
 * always applies. There is NO black-box or location/audio affordance here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminRole, IncidentStage, LiveIncident } from "@kshema/types";
import {
  ApiError,
  fetchLiveIncidents,
  retryDispatch,
} from "../../../lib/api-client";
import { LIVE_INCIDENTS_POLL_MS } from "../../../lib/config";
import { getSession } from "../../../lib/session";
import { isPermitted } from "../../../lib/rbac";
import { PageHeader, ErrorNote, Loading } from "../../../components/ui";
import { DataGrid, type Column } from "../../../components/DataGrid";
import { RequireCapability } from "../../../components/RequireCapability";

const STAGE_LABEL: Record<IncidentStage, string> = {
  STAGE_1_CONVERSATIONAL_WHATSAPP: "Stage 1 · Gentle check-in",
  STAGE_2_GENTLE_DEVICE_CHIME: "Stage 2 · Device chime",
  STAGE_3_OBSERVER_SILENT_ALERT: "Stage 3 · Observer notified",
  STAGE_4_HYPERLOCAL_DISPATCH: "Stage 4 · Hyperlocal dispatch",
};

export default function IncidentsPage(): JSX.Element {
  return (
    <RequireCapability capability="LIVE_INCIDENTS_VIEW">
      <LiveIncidentView />
    </RequireCapability>
  );
}

function LiveIncidentView(): JSX.Element {
  const [rows, setRows] = useState<LiveIncident[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setRows(await fetchLiveIncidents(signal));
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : "Could not load live incidents.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRole(getSession()?.role ?? null);
    const controller = new AbortController();
    void load(controller.signal);
    // Poll on a short cadence to keep the monitor real-time (R21.10).
    timer.current = setInterval(() => void load(), LIVE_INCIDENTS_POLL_MS);
    return () => {
      controller.abort();
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const canRetry = role != null && isPermitted(role, "RETRY_DISPATCH");

  async function onRetry(incidentId: string): Promise<void> {
    setBusyId(incidentId);
    setNotice(null);
    try {
      await retryDispatch(incidentId);
      setNotice(`Alternate-carrier fallback dispatched for incident ${incidentId}.`);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not trigger the fallback dispatch.",
      );
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<LiveIncident>[] = [
    {
      key: "incidentId",
      header: "Incident",
      render: (r) => <span className="font-mono text-xs">{r.incidentId}</span>,
    },
    { key: "stage", header: "Stage", render: (r) => STAGE_LABEL[r.stage] ?? r.stage },
    {
      key: "phone",
      header: "Anchor (masked)",
      render: (r) => <span className="tabular-nums">{r.maskedAnchorPhone}</span>,
    },
    {
      key: "openedAt",
      header: "Opened",
      render: (r) => new Date(r.openedAt).toLocaleString(),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        canRetry ? (
          <button
            type="button"
            disabled={busyId === r.incidentId}
            onClick={() => void onRetry(r.incidentId)}
            className="rounded-full border border-primary-action/40 px-3 py-1 text-xs text-primary-action hover:bg-primary-action/5 disabled:opacity-60"
          >
            {busyId === r.incidentId ? "Dispatching…" : "Retry dispatch"}
          </button>
        ) : null,
    },
  ];

  const stage4Active = rows.some(
    (r) => r.stage === "STAGE_4_HYPERLOCAL_DISPATCH",
  );

  return (
    <div>
      <PageHeader
        title="Live Incidents"
        description="Every active safety incident across the four escalation stages, refreshed continuously. Trigger an alternate-carrier fallback if an automated dispatch does not land."
      />

      {stage4Active ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-escalating/50 bg-escalating/10 px-4 py-3 text-sm text-typography"
        >
          A hyperlocal dispatch is active. Coordinate carefully — this view
          never exposes location or audio.
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="mb-4 rounded-lg border border-healthy/40 bg-healthy/10 px-4 py-3 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? <div className="mb-4"><ErrorNote message={error} /></div> : null}

      {loading && rows.length === 0 ? (
        <Loading label="Opening the incident monitor…" />
      ) : (
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(r) => r.incidentId}
          rowClassName={(r) =>
            r.stage === "STAGE_4_HYPERLOCAL_DISPATCH" ? "bg-escalating/5" : undefined
          }
          emptyLabel="All quiet — no active incidents."
        />
      )}
    </div>
  );
}

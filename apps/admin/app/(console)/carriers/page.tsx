"use client";

/**
 * Carrier Gateway Health (R21.13, R21.14). WhatsApp/SMS/IVR delivery latency
 * and rolling 15-minute error rate per gateway. A gateway whose error rate
 * exceeds 5% is highlighted (the server also trips a high-priority on-call
 * alert — R21.14). Emphasis uses Soft Amber, never a red alert indicator.
 */
import { useCallback, useEffect, useState } from "react";
import type { CarrierHealth } from "@kshema/types";
import { ApiError, fetchCarrierHealth } from "../../../lib/api-client";
import { PageHeader, ErrorNote, Loading } from "../../../components/ui";
import { DataGrid, type Column } from "../../../components/DataGrid";
import { RequireCapability } from "../../../components/RequireCapability";

/** The 5% rolling-window threshold that trips the on-call alert (R21.14). */
const ALERT_THRESHOLD = 0.05;

export default function CarriersPage(): JSX.Element {
  return (
    <RequireCapability capability="CARRIER_HEALTH_VIEW">
      <CarrierHealthView />
    </RequireCapability>
  );
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function CarrierHealthView(): JSX.Element {
  const [rows, setRows] = useState<CarrierHealth[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchCarrierHealth(undefined, signal));
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : "Could not load carrier health.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const columns: Column<CarrierHealth>[] = [
    { key: "gateway", header: "Gateway", render: (r) => <span className="font-medium">{r.gateway}</span> },
    {
      key: "errorRate",
      header: "Error rate (15m)",
      align: "right",
      render: (r) => (
        <span className={r.errorRate > ALERT_THRESHOLD ? "font-semibold text-typography" : ""}>
          {pct(r.errorRate)}
        </span>
      ),
    },
    {
      key: "latency",
      header: "Delivery latency",
      align: "right",
      render: (r) =>
        r.deliveryLatencyMs != null ? `${r.deliveryLatencyMs} ms` : "—",
    },
    {
      key: "windowStart",
      header: "Window start",
      render: (r) => new Date(r.windowStart).toLocaleString(),
    },
    {
      key: "status",
      header: "Status",
      render: (r) =>
        r.errorRate > ALERT_THRESHOLD ? (
          <span className="rounded-full bg-escalating/20 px-2 py-0.5 text-xs text-typography">
            On-call alerted
          </span>
        ) : (
          <span className="rounded-full bg-healthy/20 px-2 py-0.5 text-xs text-typography">
            Healthy
          </span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Carrier Health"
        description="Upstream messaging and voice gateway health over a rolling 15-minute window. A gateway above 5% error rate is flagged and the on-call engineer is paged automatically."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-full border border-typography/20 px-4 py-1.5 text-sm hover:bg-typography/5"
          >
            Refresh
          </button>
        }
      />

      {error ? <ErrorNote message={error} /> : null}

      {loading && rows.length === 0 ? (
        <Loading label="Reading carrier metrics…" />
      ) : (
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(r) => r.gateway}
          rowClassName={(r) => (r.errorRate > ALERT_THRESHOLD ? "bg-escalating/5" : undefined)}
          emptyLabel="No carrier samples in the current window."
        />
      )}
    </div>
  );
}

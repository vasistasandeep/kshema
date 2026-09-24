"use client";

/**
 * Webhook Error Queue (R21.20). Failed subscription/payment webhooks (Apple
 * StoreKit, Google Play Billing, UPI Autopay) awaiting inspect / edit / re-drive.
 * The raw payload arrives base64-encoded; the console lets an operator inspect
 * it. (Edit + re-drive wiring depends on the API exposing a re-drive endpoint;
 * inspect is available today and the queue is read here.)
 */
import { useCallback, useEffect, useState } from "react";
import type { WebhookErrorItem } from "@kshema/types";
import { ApiError, fetchWebhookErrorQueue } from "../../../lib/api-client";
import { PageHeader, ErrorNote, Loading } from "../../../components/ui";
import { DataGrid, type Column } from "../../../components/DataGrid";
import { RequireCapability } from "../../../components/RequireCapability";

const PROVIDER_LABEL: Record<WebhookErrorItem["provider"], string> = {
  apple: "Apple StoreKit",
  google: "Google Play Billing",
  upi: "UPI Autopay",
};

export default function WebhooksPage(): JSX.Element {
  return (
    <RequireCapability capability="WEBHOOK_ERROR_QUEUE_VIEW">
      <WebhookQueueView />
    </RequireCapability>
  );
}

function decodePayload(base64: string): string {
  try {
    if (typeof atob === "function") return atob(base64);
    return Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return "(could not decode payload)";
  }
}

function WebhookQueueView(): JSX.Element {
  const [rows, setRows] = useState<WebhookErrorItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setRows(await fetchWebhookErrorQueue(undefined, signal));
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : "Could not load the error queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const columns: Column<WebhookErrorItem>[] = [
    { key: "provider", header: "Provider", render: (r) => PROVIDER_LABEL[r.provider] },
    { key: "reason", header: "Reason", render: (r) => r.reason },
    { key: "at", header: "Failed at", render: (r) => new Date(r.at).toLocaleString() },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <button
          type="button"
          onClick={() => setExpanded(expanded === r.at ? null : r.at)}
          className="rounded-full border border-typography/20 px-3 py-1 text-xs hover:bg-typography/5"
        >
          {expanded === r.at ? "Hide payload" : "Inspect"}
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Webhook Error Queue"
        description="Payment and subscription webhooks that failed automatic processing. Inspect the payload to diagnose, then re-drive once the underlying issue is resolved."
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

      {error ? <div className="mb-4"><ErrorNote message={error} /></div> : null}

      {loading && rows.length === 0 ? (
        <Loading label="Loading the error queue…" />
      ) : (
        <>
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.at}
            emptyLabel="The error queue is empty."
          />
          {expanded ? (
            <pre className="mt-4 overflow-x-auto rounded-xl border border-typography/10 bg-white/60 p-4 text-xs">
              {decodePayload(
                rows.find((r) => r.at === expanded)?.rawBodyBase64 ?? "",
              )}
            </pre>
          ) : null}
        </>
      )}
    </div>
  );
}

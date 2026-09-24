"use client";

/**
 * Fleet Pulse (R21.15, R21.16). Aggregated background-agent reliability: active
 * circles, devices flagged "Telemetry At Risk" (>= 45 minutes / 3 missed
 * heartbeats), and open incidents. Read-only; VIEW is audited server-side.
 */
import { useCallback, useEffect, useState } from "react";
import type { FleetPulse } from "@kshema/types";
import { ApiError, fetchFleetPulse } from "../../../lib/api-client";
import { PageHeader, StatCard, ErrorNote, Loading } from "../../../components/ui";
import { RequireCapability } from "../../../components/RequireCapability";

export default function FleetPage(): JSX.Element {
  return (
    <RequireCapability capability="FLEET_PULSE_VIEW">
      <FleetPulseView />
    </RequireCapability>
  );
}

function FleetPulseView(): JSX.Element {
  const [pulse, setPulse] = useState<FleetPulse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFleetPulse(undefined, signal);
      setPulse(data);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : "Could not load the fleet pulse.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Fleet Pulse"
        description="Background-agent reliability across the Anchor device fleet. Devices silent for 45 minutes or more are flagged for follow-up."
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

      {loading && !pulse ? (
        <Loading label="Reading the fleet pulse…" />
      ) : pulse ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Active circles" value={pulse.activeCircles} tone="healthy" />
          <StatCard
            label="Telemetry at risk"
            value={pulse.telemetryAtRisk}
            tone={pulse.telemetryAtRisk > 0 ? "attention" : "healthy"}
          />
          <StatCard
            label="Open incidents"
            value={pulse.openIncidents}
            tone={pulse.openIncidents > 0 ? "attention" : "neutral"}
          />
        </div>
      ) : null}
    </div>
  );
}

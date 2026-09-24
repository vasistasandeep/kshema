import { describe, expect, it, vi } from "vitest";

import type {
  IncidentStatus,
  ResolutionSource,
} from "@kshema/database";

import { escalationJobId } from "../jobs/job-id.js";
import {
  advanceIncident,
  type EscalationDeps,
  type IncidentSnapshot,
} from "../escalation/fsm.js";
import {
  AUTO_RESOLUTION_SOURCES,
  handoffToShadowSos,
  isAutoResolutionSource,
  pendingEscalationJobIds,
  resolveIncident,
  type ResolutionDeps,
} from "./resolve.js";

const NOW = Date.UTC(2025, 0, 31, 7, 45, 0);

/** A minimal in-memory incident row the fake seams read/write. */
interface FakeIncident {
  id: string;
  circleId: string;
  anchorId: string;
  stage: IncidentSnapshot["stage"];
  status: IncidentStatus;
  resolutionSource: ResolutionSource | null;
  resolvedAt: number | null;
}

/**
 * Build spying resolution deps over a single in-memory incident. The
 * `conditionalTransition` seam mimics the production Prisma
 * `updateMany({ where: { id, status: 'OPEN' } })`: it flips the row and records
 * the source/timestamp ONLY while the row is still OPEN, and returns the
 * affected-row count (1 or 0). This is the semantic under test for idempotency.
 */
function makeDeps(initial?: Partial<FakeIncident>) {
  const incident: FakeIncident = {
    id: initial?.id ?? "incident-1",
    circleId: initial?.circleId ?? "circle-1",
    anchorId: initial?.anchorId ?? "anchor-1",
    stage: initial?.stage ?? "STAGE_1_CONVERSATIONAL_WHATSAPP",
    status: initial?.status ?? "OPEN",
    resolutionSource: initial?.resolutionSource ?? null,
    resolvedAt: initial?.resolvedAt ?? null,
  };

  /** Released black boxes, keyed by `circleId::anchorId`. */
  const releasedBoxes = new Set<string>();

  const deps: ResolutionDeps = {
    conditionalTransition: vi.fn(async ({ incidentId, toStatus, resolutionSource, resolvedAt }) => {
      if (incident.id !== incidentId || incident.status !== "OPEN") {
        return { affected: 0 };
      }
      incident.status = toStatus;
      incident.resolutionSource = resolutionSource;
      incident.resolvedAt = resolvedAt;
      return { affected: 1 };
    }),
    cancelJobs: vi.fn(async () => {
      /* removing absent jobs is a no-op */
    }),
    releaseBlackBoxes: vi.fn(async ({ circleId, anchorId }) => {
      releasedBoxes.add(`${circleId}::${anchorId}`);
    }),
  };

  return { deps, incident, releasedBoxes };
}

describe("source classification", () => {
  it("treats every non-handoff source as an Auto_Resolution_Source", () => {
    for (const source of AUTO_RESOLUTION_SOURCES) {
      expect(isAutoResolutionSource(source)).toBe(true);
    }
  });

  it("excludes SHADOW_SOS_HANDOFF from Auto_Resolution_Sources (it is a handoff)", () => {
    expect(isAutoResolutionSource("SHADOW_SOS_HANDOFF")).toBe(false);
  });
});

describe("pendingEscalationJobIds", () => {
  it("names the STAGE_2..STAGE_4 delayed advance jobs (no stage1 job exists)", () => {
    expect(pendingEscalationJobIds("abc")).toEqual([
      escalationJobId("abc", 2),
      escalationJobId("abc", 3),
      escalationJobId("abc", 4),
    ]);
  });
});

describe("resolveIncident (R13.1-13.8)", () => {
  it("transitions OPEN->RESOLVED once, records the source, and cancels pending jobs", async () => {
    const { deps, incident } = makeDeps({ id: "incident-1" });

    const result = await resolveIncident(deps, {
      incidentId: "incident-1",
      source: "SCREEN_UNLOCK",
      now: NOW,
    });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe("SCREEN_UNLOCK");
    expect(incident.status).toBe("RESOLVED");
    expect(incident.resolutionSource).toBe("SCREEN_UNLOCK");
    expect(incident.resolvedAt).toBe(NOW);

    // Pending escalation jobs cancelled by deterministic jobId.
    expect(deps.cancelJobs).toHaveBeenCalledTimes(1);
    expect(deps.cancelJobs).toHaveBeenCalledWith([
      escalationJobId("incident-1", 2),
      escalationJobId("incident-1", 3),
      escalationJobId("incident-1", 4),
    ]);
    expect(result.cancelledJobIds).toEqual([
      escalationJobId("incident-1", 2),
      escalationJobId("incident-1", 3),
      escalationJobId("incident-1", 4),
    ]);
  });

  it("resolves for any Auto_Resolution_Source and records that exact source", async () => {
    for (const source of AUTO_RESOLUTION_SOURCES) {
      const { deps, incident } = makeDeps({ id: "incident-x" });
      const result = await resolveIncident(deps, {
        incidentId: "incident-x",
        source,
        now: NOW,
      });
      expect(result.resolved).toBe(true);
      expect(incident.resolutionSource).toBe(source);
    }
  });

  it("is idempotent: a second resolution is a no-op (R13.8)", async () => {
    const { deps, incident } = makeDeps({ id: "incident-1" });

    const first = await resolveIncident(deps, {
      incidentId: "incident-1",
      source: "STEP_DELTA",
      now: NOW,
    });
    const second = await resolveIncident(deps, {
      incidentId: "incident-1",
      source: "GHOST_SIGNAL",
      now: NOW + 1000,
    });

    expect(first.resolved).toBe(true);
    expect(second.resolved).toBe(false);
    // The source recorded by the FIRST resolution is preserved (not overwritten).
    expect(incident.resolutionSource).toBe("STEP_DELTA");
    expect(incident.resolvedAt).toBe(NOW);
    // No cancellation on the idempotent no-op.
    expect(deps.cancelJobs).toHaveBeenCalledTimes(1);
    expect(second.cancelledJobIds).toEqual([]);
  });

  it("resolving an already-RESOLVED incident is a no-op", async () => {
    const { deps } = makeDeps({
      id: "incident-1",
      status: "RESOLVED",
      resolutionSource: "ANCHOR_DISMISSAL",
    });

    const result = await resolveIncident(deps, {
      incidentId: "incident-1",
      source: "OBSERVER_OVERRIDE",
      now: NOW,
    });

    expect(result.resolved).toBe(false);
    expect(deps.cancelJobs).not.toHaveBeenCalled();
  });

  it("resolving an already-HANDED_OFF_SOS incident is a no-op", async () => {
    const { deps } = makeDeps({ id: "incident-1", status: "HANDED_OFF_SOS" });

    const result = await resolveIncident(deps, {
      incidentId: "incident-1",
      source: "SCREEN_UNLOCK",
      now: NOW,
    });

    expect(result.resolved).toBe(false);
    expect(deps.cancelJobs).not.toHaveBeenCalled();
  });
});

describe("handoffToShadowSos (R13.9, R11.4)", () => {
  it("transitions OPEN->HANDED_OFF_SOS, cancels timed jobs, and releases black boxes", async () => {
    const { deps, incident, releasedBoxes } = makeDeps({
      id: "incident-1",
      circleId: "circle-1",
      anchorId: "anchor-1",
      stage: "STAGE_3_OBSERVER_SILENT_ALERT",
    });

    const result = await handoffToShadowSos(deps, {
      incidentId: "incident-1",
      circleId: "circle-1",
      anchorId: "anchor-1",
      now: NOW,
    });

    expect(result.handedOff).toBe(true);
    expect(result.releasedBlackBoxes).toBe(true);
    expect(incident.status).toBe("HANDED_OFF_SOS");
    expect(incident.resolutionSource).toBe("SHADOW_SOS_HANDOFF");
    expect(incident.resolvedAt).toBe(NOW);

    expect(deps.cancelJobs).toHaveBeenCalledWith([
      escalationJobId("incident-1", 2),
      escalationJobId("incident-1", 3),
      escalationJobId("incident-1", 4),
    ]);
    expect(deps.releaseBlackBoxes).toHaveBeenCalledWith({
      circleId: "circle-1",
      anchorId: "anchor-1",
    });
    expect(releasedBoxes.has("circle-1::anchor-1")).toBe(true);
  });

  it("supersedes timed advancement: a subsequent advance is a no-op", async () => {
    const { deps, incident } = makeDeps({
      id: "incident-1",
      stage: "STAGE_2_GENTLE_DEVICE_CHIME",
    });

    // Hand off to Shadow_SOS.
    const handoff = await handoffToShadowSos(deps, {
      incidentId: "incident-1",
      circleId: "circle-1",
      anchorId: "anchor-1",
      now: NOW,
    });
    expect(handoff.handedOff).toBe(true);
    expect(incident.status).toBe("HANDED_OFF_SOS");

    // Now run a timed escalation advance against the SAME incident. The FSM
    // re-reads status and must bail: no side effect, no stage change (R13.9).
    const escalationScheduled = vi.fn(async () => undefined);
    const escalationEffect = vi.fn(async () => undefined);
    const escalationDeps: EscalationDeps = {
      createIncident: vi.fn(async () => ({ id: incident.id })),
      readIncident: vi.fn(async (id) =>
        id === incident.id
          ? { id: incident.id, stage: incident.stage, status: incident.status }
          : null,
      ),
      applyAdvance: vi.fn(async () => undefined),
      scheduleAdvance: escalationScheduled,
      performSideEffect: escalationEffect,
    };

    const outcome = await advanceIncident(escalationDeps, {
      incidentId: incident.id,
      now: NOW + 20 * 60 * 1000,
      stageIntervalMs: 20 * 60 * 1000,
    });

    expect(outcome.advanced).toBe(false);
    if (!outcome.advanced) {
      expect(outcome.reason).toBe("not-open");
      expect(outcome.status).toBe("HANDED_OFF_SOS");
    }
    expect(escalationEffect).not.toHaveBeenCalled();
    expect(escalationScheduled).not.toHaveBeenCalled();
    // Incident stayed at the stage it was at when handed off (no advancement).
    expect(incident.stage).toBe("STAGE_2_GENTLE_DEVICE_CHIME");
  });

  it("is idempotent: handoff on an already-terminal incident is a no-op", async () => {
    const { deps } = makeDeps({ id: "incident-1", status: "RESOLVED" });

    const result = await handoffToShadowSos(deps, {
      incidentId: "incident-1",
      circleId: "circle-1",
      anchorId: "anchor-1",
      now: NOW,
    });

    expect(result.handedOff).toBe(false);
    expect(result.releasedBlackBoxes).toBe(false);
    expect(deps.cancelJobs).not.toHaveBeenCalled();
    expect(deps.releaseBlackBoxes).not.toHaveBeenCalled();
  });
});

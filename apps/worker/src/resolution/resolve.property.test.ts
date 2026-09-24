import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import type {
  IncidentStatus,
  ResolutionSource,
} from "@kshema/database";

import { escalationJobId } from "../jobs/job-id.js";
import {
  advanceIncident,
  STAGE_ORDER,
  type EscalationDeps,
  type IncidentSnapshot,
} from "../escalation/fsm.js";
import {
  AUTO_RESOLUTION_SOURCES,
  pendingEscalationJobIds,
  resolveIncident,
  type ResolutionDeps,
} from "./resolve.js";

// Feature: kshema-safety-platform, Property 7
//
// Property 7: Auto-resolution is idempotent and halts escalation.
//
// For all open Safety_Incidents and any sequence containing at least one
// resolving event (any Auto_Resolution_Source), the FIRST resolving event sets
// status RESOLVED and records the source and halts escalation (cancels the
// pending stage jobs), every SUBSEQUENT event is a strict no-op (idempotent),
// and no Escalation_Stage advancement occurs after resolution.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8

const RUNS = 200; // >= 100 iterations required by the task.
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
 * the source/timestamp ONLY while the row is still OPEN and returns the
 * affected-row count (1 on the first OPEN->RESOLVED, 0 afterwards). This is the
 * exact semantic that makes auto-resolution idempotent (R13.8).
 */
function makeModel(initial?: Partial<FakeIncident>) {
  const incident: FakeIncident = {
    id: initial?.id ?? "incident-1",
    circleId: initial?.circleId ?? "circle-1",
    anchorId: initial?.anchorId ?? "anchor-1",
    stage: initial?.stage ?? "STAGE_1_CONVERSATIONAL_WHATSAPP",
    status: initial?.status ?? "OPEN",
    resolutionSource: initial?.resolutionSource ?? null,
    resolvedAt: initial?.resolvedAt ?? null,
  };

  const deps: ResolutionDeps = {
    conditionalTransition: vi.fn(
      async ({ incidentId, toStatus, resolutionSource, resolvedAt }) => {
        if (incident.id !== incidentId || incident.status !== "OPEN") {
          return { affected: 0 };
        }
        incident.status = toStatus;
        incident.resolutionSource = resolutionSource;
        incident.resolvedAt = resolvedAt;
        return { affected: 1 };
      },
    ),
    cancelJobs: vi.fn(async () => {
      /* removing absent jobs is a no-op */
    }),
    releaseBlackBoxes: vi.fn(async () => {
      /* never invoked on auto-resolution */
    }),
  };

  return { deps, incident };
}

/** An escalation `advance` job wired to READ the same in-memory incident. */
function makeEscalationProbe(incident: FakeIncident) {
  const scheduleAdvance = vi.fn(async () => undefined);
  const performSideEffect = vi.fn(async () => undefined);
  const applyAdvance = vi.fn(async () => undefined);
  const escalationDeps: EscalationDeps = {
    createIncident: vi.fn(async () => ({ id: incident.id })),
    readIncident: vi.fn(async (id) =>
      id === incident.id
        ? { id: incident.id, stage: incident.stage, status: incident.status }
        : null,
    ),
    applyAdvance,
    scheduleAdvance,
    performSideEffect,
  };
  return { escalationDeps, scheduleAdvance, performSideEffect, applyAdvance };
}

/** Any Auto_Resolution_Source (R13.1-13.7). */
const arbSource = (): fc.Arbitrary<ResolutionSource> =>
  fc.constantFrom(...AUTO_RESOLUTION_SOURCES);

describe("Property 7: auto-resolution is idempotent and halts escalation", () => {
  it("first resolving event resolves + cancels; every later event is a strict no-op (R13.1-13.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A sequence of >= 1 resolving events, any source, possibly repeated,
        // and an arbitrary starting stage for the OPEN incident.
        fc.array(arbSource(), { minLength: 1, maxLength: 8 }),
        fc.constantFrom(...STAGE_ORDER),
        async (sources, startStage) => {
          const { deps, incident } = makeModel({ stage: startStage });
          const expectedJobIds = pendingEscalationJobIds(incident.id);

          const results = [];
          for (let i = 0; i < sources.length; i += 1) {
            results.push(
              // eslint-disable-next-line no-await-in-loop
              await resolveIncident(deps, {
                incidentId: incident.id,
                source: sources[i]!,
                now: NOW + i,
              }),
            );
          }

          const [first, ...rest] = results;

          // FIRST event: real OPEN->RESOLVED transition recording the source
          // and halting escalation via cancellation (R13.1-13.8).
          expect(first!.resolved).toBe(true);
          expect(first!.source).toBe(sources[0]);
          expect(first!.cancelledJobIds).toEqual(expectedJobIds);
          expect(incident.status).toBe("RESOLVED");
          expect(incident.resolutionSource).toBe(sources[0]);
          expect(incident.resolvedAt).toBe(NOW);

          // Escalation halted exactly once, with the deterministic stage ids.
          expect(deps.cancelJobs).toHaveBeenCalledTimes(1);
          expect(deps.cancelJobs).toHaveBeenCalledWith(expectedJobIds);

          // EVERY subsequent event: strict no-op. No further transition, the
          // originally-recorded source/timestamp is preserved (not overwritten
          // by a later, different source), and no additional cancellation.
          for (const later of rest) {
            expect(later.resolved).toBe(false);
            expect(later.cancelledJobIds).toEqual([]);
          }
          expect(incident.status).toBe("RESOLVED");
          expect(incident.resolutionSource).toBe(sources[0]);
          expect(incident.resolvedAt).toBe(NOW);
          // Idempotent: cancellation never happened again (R13.8).
          expect(deps.cancelJobs).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("every Auto_Resolution_Source individually resolves an OPEN incident (R13.1-13.7)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSource(),
        fc.constantFrom(...STAGE_ORDER),
        async (source, startStage) => {
          const { deps, incident } = makeModel({ stage: startStage });

          const result = await resolveIncident(deps, {
            incidentId: incident.id,
            source,
            now: NOW,
          });

          expect(result.resolved).toBe(true);
          expect(result.source).toBe(source);
          expect(incident.status).toBe("RESOLVED");
          expect(incident.resolutionSource).toBe(source);
          expect(result.cancelledJobIds).toEqual([
            escalationJobId(incident.id, 2),
            escalationJobId(incident.id, 3),
            escalationJobId(incident.id, 4),
          ]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("after resolution, a timed escalation advance reads RESOLVED and is a no-op (R13.8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSource(),
        fc.constantFrom(...STAGE_ORDER),
        async (source, startStage) => {
          const { deps, incident } = makeModel({ stage: startStage });

          await resolveIncident(deps, {
            incidentId: incident.id,
            source,
            now: NOW,
          });
          expect(incident.status).toBe("RESOLVED");

          // Simulate a delayed `advance` job firing AFTER resolution: the FSM
          // re-reads the now-RESOLVED status and must bail with no side effects
          // and no further scheduling (escalation halted).
          const { escalationDeps, scheduleAdvance, performSideEffect, applyAdvance } =
            makeEscalationProbe(incident);

          const outcome = await advanceIncident(escalationDeps, {
            incidentId: incident.id,
            now: NOW + 20 * 60 * 1000,
            stageIntervalMs: 20 * 60 * 1000,
          });

          expect(outcome.advanced).toBe(false);
          if (!outcome.advanced) {
            expect(outcome.reason).toBe("not-open");
            expect(outcome.status).toBe("RESOLVED");
          }
          expect(applyAdvance).not.toHaveBeenCalled();
          expect(performSideEffect).not.toHaveBeenCalled();
          expect(scheduleAdvance).not.toHaveBeenCalled();
          // Stage never advanced past where it was at resolution time.
          expect(incident.stage).toBe(startStage);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

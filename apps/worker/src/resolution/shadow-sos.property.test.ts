// Feature: kshema-safety-platform, Property 8
/**
 * Property 8: Shadow SOS handoff supersedes timed advancement.
 *
 * *For all* unresolved Safety_Incidents at any stage, triggering a Shadow_SOS
 * SHALL transition the incident to HANDED_OFF_SOS status and SHALL prevent any
 * further timed stage advancement (design "Property 8").
 *
 * The two terminal transitions live in different modules that share the same
 * incident row via injectable seams:
 *   - {@link handoffToShadowSos} ({@link ResolutionDeps}) flips OPEN →
 *     HANDED_OFF_SOS, cancels the pending timed `advance` jobs, and releases the
 *     authorized black boxes (R13.9, R11.4).
 *   - {@link advanceIncident} ({@link EscalationDeps}) re-reads status on every
 *     timed tick and no-ops unless the incident is still OPEN.
 *
 * This test wires ONE in-memory incident behind BOTH seams (the same
 * `conditionalTransition`-style row the unit tests use) so the property drives
 * the genuine cross-module interaction. It covers, over arbitrary interleavings
 * of a handoff and timed advances started from ANY stage 1..4:
 *   - once the handoff sets HANDED_OFF_SOS (from OPEN), every subsequent
 *     advance is a strict no-op and the stage never moves again (R13.9);
 *   - the handoff cancels the pending timed jobs and releases the black boxes
 *     exactly once (R11.4/R13.9);
 *   - a handoff arriving at ANY stage supersedes all remaining timed
 *     advancement, no matter how many advances were pending;
 *   - the handoff is idempotent — a second handoff, or a handoff after
 *     resolution, is a no-op with no extra cancellation or release.
 *
 * Two complementary property styles are used: a model-based (`fc.commands`)
 * interleaving run, plus focused arbitrary-sequence checks that pin the
 * "supersedes at any starting stage" and idempotency invariants directly.
 *
 * Validates: Requirements 13.9, 11.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type {
  IncidentStage,
  IncidentStatus,
  ResolutionSource,
} from "@kshema/database";

import { escalationJobId } from "../jobs/job-id.js";
import {
  advanceIncident,
  nextStage,
  STAGE_ORDER,
  type AuditEntry,
  type EscalationDeps,
} from "../escalation/fsm.js";
import {
  handoffToShadowSos,
  pendingEscalationJobIds,
  resolveIncident,
  type ResolutionDeps,
} from "./resolve.js";

const STAGE_INTERVAL_MS = 20 * 60 * 1000;

/** A minimal in-memory incident row shared behind both dep seams. */
interface FakeIncident {
  id: string;
  circleId: string;
  anchorId: string;
  stage: IncidentStage;
  status: IncidentStatus;
  resolutionSource: ResolutionSource | null;
  resolvedAt: number | null;
  auditTrail: AuditEntry[];
}

/**
 * The wiring shared by every scenario: one incident row, resolution deps
 * (`conditionalTransition` mimics the Prisma `updateMany WHERE status='OPEN'`),
 * and escalation deps that read/write the SAME row. Cancellation and release
 * are observed via spy counters/sets so we can assert they happen once and only
 * on a real transition.
 */
interface Wiring {
  incident: FakeIncident;
  resolutionDeps: ResolutionDeps;
  escalationDeps: EscalationDeps;
  /** All jobId arrays passed to cancelJobs, in call order. */
  cancelCalls: string[][];
  /** Released black boxes keyed by `circleId::anchorId`. */
  releasedBoxes: Set<string>;
  /** Count of releaseBlackBoxes invocations. */
  releaseCount: number;
}

function makeWiring(startStage: IncidentStage): Wiring {
  const incident: FakeIncident = {
    id: "incident-1",
    circleId: "circle-1",
    anchorId: "anchor-1",
    stage: startStage,
    status: "OPEN",
    resolutionSource: null,
    resolvedAt: null,
    auditTrail: [{ stage: startStage, at: 0, cause: "seed" }],
  };

  const cancelCalls: string[][] = [];
  const releasedBoxes = new Set<string>();
  const w = {
    incident,
    cancelCalls,
    releasedBoxes,
    releaseCount: 0,
  } as Wiring;

  w.resolutionDeps = {
    conditionalTransition: async ({
      incidentId,
      toStatus,
      resolutionSource,
      resolvedAt,
    }) => {
      // Conditional update scoped to status === 'OPEN' (idempotency source).
      if (incident.id !== incidentId || incident.status !== "OPEN") {
        return { affected: 0 };
      }
      incident.status = toStatus;
      incident.resolutionSource = resolutionSource;
      incident.resolvedAt = resolvedAt;
      return { affected: 1 };
    },
    cancelJobs: async (jobIds) => {
      cancelCalls.push([...jobIds]);
    },
    releaseBlackBoxes: async ({ circleId, anchorId }) => {
      releasedBoxes.add(`${circleId}::${anchorId}`);
      w.releaseCount += 1;
    },
  };

  w.escalationDeps = {
    createIncident: async () => ({ id: incident.id }),
    readIncident: async (id) =>
      id === incident.id
        ? { id: incident.id, stage: incident.stage, status: incident.status }
        : null,
    applyAdvance: async ({ incidentId, stage, entry }) => {
      if (incidentId !== incident.id) {
        throw new Error(`applyAdvance: no incident ${incidentId}`);
      }
      incident.stage = stage;
      incident.auditTrail.push(entry);
    },
    scheduleAdvance: async () => undefined,
    performSideEffect: async () => undefined,
  };

  return w;
}

/**
 * The reference model tracking what SHOULD be true independently of the
 * implementation.
 */
interface Model {
  stage: IncidentStage;
  status: IncidentStatus;
  /** Set once a real (affected=1) handoff has happened. */
  handedOff: boolean;
  /** Number of real handoff transitions (must be at most 1). */
  handoffCount: number;
  /** Number of real releaseBlackBoxes calls we expect (at most 1). */
  expectedReleaseCount: number;
}

/** Assert the row + observers match the model after a command. */
function assertInvariants(model: Model, w: Wiring): void {
  expect(w.incident.status).toBe(model.status);
  expect(w.incident.stage).toBe(model.stage);

  // Release happens exactly on the real handoff transition and never again.
  expect(w.releaseCount).toBe(model.expectedReleaseCount);
  expect(model.handoffCount).toBeLessThanOrEqual(1);

  if (model.handedOff) {
    // Handed off ⇒ status is HANDED_OFF_SOS and source recorded.
    expect(w.incident.status).toBe("HANDED_OFF_SOS");
    expect(w.incident.resolutionSource).toBe("SHADOW_SOS_HANDOFF");
    // Black boxes for this incident's circle/anchor were released.
    expect(w.releasedBoxes.has(`${w.incident.circleId}::${w.incident.anchorId}`)).toBe(
      true,
    );
  }
}

interface RealState {
  w: Wiring;
}

/** Command: fire one timed `advance` tick against the shared incident. */
class AdvanceCommand implements fc.AsyncCommand<Model, RealState> {
  constructor(private readonly at: number) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: RealState): Promise<void> {
    const willAdvance =
      model.status === "OPEN" && nextStage(model.stage) !== null;
    const expectedNext = willAdvance ? nextStage(model.stage) : null;
    const stageBefore = model.stage;

    const outcome = await advanceIncident(real.w.escalationDeps, {
      incidentId: real.w.incident.id,
      now: this.at,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    if (willAdvance) {
      expect(outcome.advanced).toBe(true);
      if (!outcome.advanced) throw new Error("expected advance");
      expect(outcome.stage).toBe(expectedNext);
      model.stage = expectedNext!;
    } else {
      // Non-OPEN (handed off) or terminal STAGE_4 ⇒ strict no-op.
      expect(outcome.advanced).toBe(false);
      // Once handed off, the tick must never move the stage.
      if (model.handedOff) {
        expect(real.w.incident.stage).toBe(stageBefore);
        if (!outcome.advanced) {
          expect(outcome.reason).toBe("not-open");
          expect(outcome.status).toBe("HANDED_OFF_SOS");
        }
      }
    }

    assertInvariants(model, real.w);
  }

  toString(): string {
    return `Advance@${this.at}`;
  }
}

/** Command: trigger a Shadow_SOS handoff against the shared incident. */
class HandoffCommand implements fc.AsyncCommand<Model, RealState> {
  constructor(private readonly at: number) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: RealState): Promise<void> {
    const wasOpen = model.status === "OPEN";
    const cancelCallsBefore = real.w.cancelCalls.length;

    const result = await handoffToShadowSos(real.w.resolutionDeps, {
      incidentId: real.w.incident.id,
      circleId: real.w.incident.circleId,
      anchorId: real.w.incident.anchorId,
      now: this.at,
    });

    if (wasOpen) {
      // First handoff from OPEN: a real transition (supersedes advancement).
      expect(result.handedOff).toBe(true);
      expect(result.releasedBlackBoxes).toBe(true);
      // Cancels exactly the STAGE_2..4 pending timed jobs.
      expect(result.cancelledJobIds).toEqual(
        pendingEscalationJobIds(real.w.incident.id),
      );
      expect(real.w.cancelCalls.length).toBe(cancelCallsBefore + 1);
      expect(real.w.cancelCalls[real.w.cancelCalls.length - 1]).toEqual([
        escalationJobId(real.w.incident.id, 2),
        escalationJobId(real.w.incident.id, 3),
        escalationJobId(real.w.incident.id, 4),
      ]);
      model.status = "HANDED_OFF_SOS";
      model.handedOff = true;
      model.handoffCount += 1;
      model.expectedReleaseCount += 1;
    } else {
      // Incident already terminal ⇒ idempotent no-op: no cancel, no release.
      expect(result.handedOff).toBe(false);
      expect(result.releasedBlackBoxes).toBe(false);
      expect(result.cancelledJobIds).toEqual([]);
      expect(real.w.cancelCalls.length).toBe(cancelCallsBefore);
    }

    assertInvariants(model, real.w);
  }

  toString(): string {
    return `Handoff@${this.at}`;
  }
}

/**
 * Command: resolve the incident out-of-band (models an Auto_Resolution_Source
 * landing). Lets us exercise "handoff after resolution is a no-op".
 */
class ResolveCommand implements fc.AsyncCommand<Model, RealState> {
  constructor(private readonly at: number) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: RealState): Promise<void> {
    const wasOpen = model.status === "OPEN";

    const result = await resolveIncident(real.w.resolutionDeps, {
      incidentId: real.w.incident.id,
      source: "SCREEN_UNLOCK",
      now: this.at,
    });

    if (wasOpen) {
      expect(result.resolved).toBe(true);
      model.status = "RESOLVED";
    } else {
      expect(result.resolved).toBe(false);
    }

    assertInvariants(model, real.w);
  }

  toString(): string {
    return `Resolve@${this.at}`;
  }
}

describe("Property 8: Shadow SOS handoff supersedes timed advancement", () => {
  it("under any interleaving of a handoff and timed advances from any stage, handoff wins (model-based)", async () => {
    const startStage = fc.constantFrom<IncidentStage>(...STAGE_ORDER);
    const at = fc.integer({ min: 1, max: 10_000_000 });

    const commands = fc.commands(
      [
        at.map((t) => new AdvanceCommand(t)),
        at.map((t) => new HandoffCommand(t)),
        at.map((t) => new ResolveCommand(t)),
      ],
      { maxCommands: 20 },
    );

    await fc.assert(
      fc.asyncProperty(startStage, commands, async (stage, cmds) => {
        // Construct fresh model + real state INSIDE setup so fast-check's
        // replay/clone runs each start from a clean incident row.
        await fc.asyncModelRun(() => {
          const w = makeWiring(stage);
          const real: RealState = { w };
          const model: Model = {
            stage,
            status: "OPEN",
            handedOff: false,
            handoffCount: 0,
            expectedReleaseCount: 0,
          };
          return { model, real };
        }, cmds);
      }),
      { numRuns: 200 },
    );
  });

  it("a handoff at ANY starting stage supersedes every remaining pending advance (arbitrary-sequence)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<IncidentStage>(...STAGE_ORDER),
        // Number of pending timed advances that "fire" AFTER the handoff.
        fc.integer({ min: 1, max: 8 }),
        async (startStage, pendingAdvances) => {
          const w = makeWiring(startStage);

          const handoff = await handoffToShadowSos(w.resolutionDeps, {
            incidentId: w.incident.id,
            circleId: w.incident.circleId,
            anchorId: w.incident.anchorId,
            now: 100,
          });
          expect(handoff.handedOff).toBe(true);
          expect(w.incident.status).toBe("HANDED_OFF_SOS");
          const stageAtHandoff = w.incident.stage;

          // Every pending timed advance that fires after handoff is a no-op:
          // the stage never advances again, regardless of how many were queued.
          for (let i = 0; i < pendingAdvances; i++) {
            const outcome = await advanceIncident(w.escalationDeps, {
              incidentId: w.incident.id,
              now: 200 + i,
              stageIntervalMs: STAGE_INTERVAL_MS,
            });
            expect(outcome.advanced).toBe(false);
            if (!outcome.advanced) {
              expect(outcome.reason).toBe("not-open");
              expect(outcome.status).toBe("HANDED_OFF_SOS");
            }
            expect(w.incident.stage).toBe(stageAtHandoff);
          }

          // Cancellation + release happened exactly once at handoff.
          expect(w.cancelCalls.length).toBe(1);
          expect(w.releaseCount).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("handoff is idempotent: a second handoff (or one after resolution) is a no-op", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<IncidentStage>(...STAGE_ORDER),
        // false ⇒ second handoff; true ⇒ resolve first, then handoff.
        fc.boolean(),
        async (startStage, resolveFirst) => {
          const w = makeWiring(startStage);

          if (resolveFirst) {
            const resolved = await resolveIncident(w.resolutionDeps, {
              incidentId: w.incident.id,
              source: "GHOST_SIGNAL",
              now: 100,
            });
            expect(resolved.resolved).toBe(true);
            // Handoff after resolution: no-op (row is no longer OPEN).
            const late = await handoffToShadowSos(w.resolutionDeps, {
              incidentId: w.incident.id,
              circleId: w.incident.circleId,
              anchorId: w.incident.anchorId,
              now: 200,
            });
            expect(late.handedOff).toBe(false);
            expect(late.releasedBlackBoxes).toBe(false);
            expect(late.cancelledJobIds).toEqual([]);
            // Resolution's own cancel ran once; handoff added none.
            expect(w.incident.status).toBe("RESOLVED");
            expect(w.releaseCount).toBe(0);
          } else {
            const first = await handoffToShadowSos(w.resolutionDeps, {
              incidentId: w.incident.id,
              circleId: w.incident.circleId,
              anchorId: w.incident.anchorId,
              now: 100,
            });
            expect(first.handedOff).toBe(true);
            const second = await handoffToShadowSos(w.resolutionDeps, {
              incidentId: w.incident.id,
              circleId: w.incident.circleId,
              anchorId: w.incident.anchorId,
              now: 200,
            });
            expect(second.handedOff).toBe(false);
            expect(second.releasedBlackBoxes).toBe(false);
            expect(second.cancelledJobIds).toEqual([]);
            // Cancel + release happened exactly once (on the first handoff).
            expect(w.cancelCalls.length).toBe(1);
            expect(w.releaseCount).toBe(1);
            expect(w.incident.status).toBe("HANDED_OFF_SOS");
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

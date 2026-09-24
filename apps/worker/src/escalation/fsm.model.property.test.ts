// Feature: kshema-safety-platform, Property 6
/**
 * Property 6: Escalation advances strictly in order.
 *
 * *For all* interleavings of timeout ticks and non-resolving events applied to
 * an open Safety_Incident, the sequence of stages entered SHALL be a strictly
 * increasing prefix of `[STAGE_1, STAGE_2, STAGE_3, STAGE_4]` — never skipping a
 * stage and never regressing (design "Property 6").
 *
 * This is a model-based (`fc.commands`) test. A tiny reference *model* tracks
 * the incident's expected stage/status and the ordered list of stages it has
 * entered; the *real* FSM ({@link openIncident} / {@link advanceIncident}) is
 * driven against injected in-memory deps that persist stage / status /
 * auditTrail. The commands interleave:
 *   - OpenCommand    — open the incident at STAGE_1 (once),
 *   - AdvanceCommand — fire one `advance` job (a timeout tick),
 *   - ResolveCommand — mark the incident RESOLVED out-of-band,
 *   - HandoffCommand — mark the incident HANDED_OFF_SOS out-of-band.
 *
 * After every command we assert the invariants:
 *   - the stage only ever moves forward by exactly one step in STAGE_ORDER
 *     (never skips, never regresses) — R12.2–12.5,
 *   - an advance never moves past the terminal STAGE_4, and never advances a
 *     non-OPEN incident (RESOLVED / HANDED_OFF_SOS advances are strict no-ops),
 *   - the persisted audit trail is a strictly increasing sequence of stages
 *     that matches exactly the transitions the model took.
 *
 * Validates: Requirements 12.2, 12.3, 12.4, 12.5
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { IncidentStage, IncidentStatus } from "@kshema/database";

import {
  advanceIncident,
  openIncident,
  nextStage,
  stageNumber,
  STAGE_ORDER,
  type AuditEntry,
  type EscalationDeps,
  type IncidentSnapshot,
  type ScheduledAdvance,
  type StageSideEffect,
} from "./fsm.js";

const STAGE_INTERVAL_MS = 20 * 60 * 1000;

/** Terminal (non-OPEN) statuses the escalation FSM must treat as no-ops. */
const TERMINAL_STATUSES = ["RESOLVED", "HANDED_OFF_SOS"] as const;

/**
 * The real-world side of the test: an in-memory incident store wired through
 * the {@link EscalationDeps} seams. This is the exact shape the unit tests use,
 * kept minimal so the property drives the genuine FSM logic (no mocking of the
 * transition rules themselves).
 */
interface Store {
  deps: EscalationDeps;
  incidents: Map<string, IncidentSnapshot & { auditTrail: AuditEntry[] }>;
  scheduled: ScheduledAdvance[];
  effects: StageSideEffect[];
}

function makeStore(): Store {
  const incidents = new Map<
    string,
    IncidentSnapshot & { auditTrail: AuditEntry[] }
  >();
  const scheduled: ScheduledAdvance[] = [];
  const effects: StageSideEffect[] = [];
  let seq = 0;

  const deps: EscalationDeps = {
    createIncident: async (input) => {
      const id = `incident-${++seq}`;
      incidents.set(id, {
        id,
        stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
        status: "OPEN",
        auditTrail: [...input.auditTrail],
      });
      return { id };
    },
    readIncident: async (id) => {
      const rec = incidents.get(id);
      if (!rec) return null;
      return { id: rec.id, stage: rec.stage, status: rec.status };
    },
    applyAdvance: async ({ incidentId, stage, entry }) => {
      const rec = incidents.get(incidentId);
      if (!rec) throw new Error(`applyAdvance: no incident ${incidentId}`);
      rec.stage = stage;
      rec.auditTrail.push(entry);
    },
    scheduleAdvance: async (advance) => {
      scheduled.push(advance);
    },
    performSideEffect: async (effect) => {
      effects.push(effect);
    },
  };

  return { deps, incidents, scheduled, effects };
}

/**
 * The reference model: what we *expect* the incident to look like. It mirrors
 * the FSM's rules independently so the assertions do not merely restate the
 * implementation.
 */
interface Model {
  /** Set once the incident has been opened. */
  incidentId: string | null;
  /** Expected current stage (null before open). */
  stage: IncidentStage | null;
  /** Expected current status (null before open). */
  status: IncidentStatus | null;
  /** Ordered list of stages entered, in the order the model transitioned. */
  enteredStages: IncidentStage[];
}

/** A shared handle threaded through commands so the model can find its store row. */
interface RealState {
  store: Store;
  /** Filled in by OpenCommand once the real FSM returns an id. */
  incidentId: string | null;
}

/**
 * Assert the whole-history stage invariant: the entered-stage list is a strict,
 * gap-free, non-regressing prefix of STAGE_ORDER (R12.2–12.5), and it matches
 * the audit trail the real FSM persisted.
 */
function assertInvariants(model: Model, real: RealState): void {
  const entered = model.enteredStages;

  // 1. Strictly increasing prefix of STAGE_ORDER: entry k is exactly
  //    STAGE_ORDER[k] — never skips, never regresses.
  for (let k = 0; k < entered.length; k++) {
    expect(entered[k]).toBe(STAGE_ORDER[k]);
    if (k > 0) {
      // Each step advances the ordinal by exactly one.
      expect(stageNumber(entered[k]!)).toBe(stageNumber(entered[k - 1]!) + 1);
    }
  }

  // 2. Never advances past terminal STAGE_4.
  expect(entered.length).toBeLessThanOrEqual(STAGE_ORDER.length);
  if (entered.length > 0) {
    const last = entered[entered.length - 1]!;
    // The current stage equals the last entered stage.
    expect(model.stage).toBe(last);
  }

  if (real.incidentId === null) {
    // Not opened yet: nothing persisted.
    expect(entered).toHaveLength(0);
    return;
  }

  // 3. The persisted audit trail is the same strictly increasing stage
  //    sequence as the transitions the model took.
  const rec = real.store.incidents.get(real.incidentId)!;
  const persistedStages = rec.auditTrail.map((e) => e.stage);
  expect(persistedStages).toEqual(entered);
  // Real store's current stage/status track the model exactly.
  expect(rec.stage).toBe(model.stage);
  expect(rec.status).toBe(model.status);
}

/** Command: open the incident at STAGE_1 (a precondition-gated one-shot). */
class OpenCommand implements fc.AsyncCommand<Model, RealState> {
  check(model: Model): boolean {
    return model.incidentId === null;
  }

  async run(model: Model, real: RealState): Promise<void> {
    const result = await openIncident(real.store.deps, {
      circleId: "circle-model",
      anchorId: "anchor-model",
      cause: "GRACE_DEADLINE_MISS",
      now: 1_000,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });
    real.incidentId = result.incidentId;
    model.incidentId = result.incidentId;
    model.stage = "STAGE_1_CONVERSATIONAL_WHATSAPP";
    model.status = "OPEN";
    model.enteredStages.push("STAGE_1_CONVERSATIONAL_WHATSAPP");

    assertInvariants(model, real);
  }

  toString(): string {
    return "Open";
  }
}

/** Command: fire one `advance` job (a timeout tick). */
class AdvanceCommand implements fc.AsyncCommand<Model, RealState> {
  constructor(private readonly at: number) {}

  check(model: Model): boolean {
    return model.incidentId !== null;
  }

  async run(model: Model, real: RealState): Promise<void> {
    const id = model.incidentId!;
    // Model's expectation: only an OPEN, non-terminal incident advances one
    // stage; otherwise the tick is a strict no-op.
    const willAdvance =
      model.status === "OPEN" && nextStage(model.stage!) !== null;
    const expectedNext = willAdvance ? nextStage(model.stage!) : null;

    const outcome = await advanceIncident(real.store.deps, {
      incidentId: id,
      now: this.at,
      stageIntervalMs: STAGE_INTERVAL_MS,
    });

    if (willAdvance) {
      expect(outcome.advanced).toBe(true);
      if (!outcome.advanced) throw new Error("expected advance");
      expect(outcome.stage).toBe(expectedNext);
      model.stage = expectedNext;
      model.enteredStages.push(expectedNext!);
    } else {
      // No-op: non-OPEN status or already terminal STAGE_4.
      expect(outcome.advanced).toBe(false);
    }

    assertInvariants(model, real);
  }

  toString(): string {
    return `Advance@${this.at}`;
  }
}

/**
 * Command: mark the incident RESOLVED out-of-band (models auto-resolution /
 * task 10.3). After this, advances must be strict no-ops.
 */
class ResolveCommand implements fc.AsyncCommand<Model, RealState> {
  check(model: Model): boolean {
    return model.incidentId !== null && model.status === "OPEN";
  }

  async run(model: Model, real: RealState): Promise<void> {
    const rec = real.store.incidents.get(model.incidentId!)!;
    rec.status = "RESOLVED";
    model.status = "RESOLVED";

    assertInvariants(model, real);
  }

  toString(): string {
    return "Resolve";
  }
}

/**
 * Command: mark the incident HANDED_OFF_SOS out-of-band (models Shadow_SOS
 * handoff). After this, advances must be strict no-ops.
 */
class HandoffCommand implements fc.AsyncCommand<Model, RealState> {
  check(model: Model): boolean {
    return model.incidentId !== null && model.status === "OPEN";
  }

  async run(model: Model, real: RealState): Promise<void> {
    const rec = real.store.incidents.get(model.incidentId!)!;
    rec.status = "HANDED_OFF_SOS";
    model.status = "HANDED_OFF_SOS";

    assertInvariants(model, real);
  }

  toString(): string {
    return "Handoff";
  }
}

describe("Property 6: escalation advances strictly in order (model-based)", () => {
  it("stages form a strictly increasing prefix of STAGE_ORDER under any interleaving", async () => {
    const allCommands = fc.commands(
      [
        fc.constant(new OpenCommand()),
        fc
          .integer({ min: 2_000, max: 10_000_000 })
          .map((at) => new AdvanceCommand(at)),
        fc.constant(new ResolveCommand()),
        fc.constant(new HandoffCommand()),
      ],
      { maxCommands: 20 },
    );

    await fc.assert(
      fc.asyncProperty(allCommands, async (cmds) => {
        const store = makeStore();
        const real: RealState = { store, incidentId: null };
        const model: Model = {
          incidentId: null,
          stage: null,
          status: null,
          enteredStages: [],
        };
        await fc.asyncModelRun(() => ({ model, real }), cmds);
      }),
      { numRuns: 200 },
    );
  });

  it("a terminal (RESOLVED/HANDED_OFF_SOS) incident never advances again", async () => {
    // A focused companion check: once terminal, no number of ticks moves the
    // stage. Complements the interleaved model run above.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<(typeof TERMINAL_STATUSES)[number]>(
          ...TERMINAL_STATUSES,
        ),
        fc.integer({ min: 1, max: 6 }),
        async (terminalStatus, tickCount) => {
          const store = makeStore();
          const opened = await openIncident(store.deps, {
            circleId: "c",
            anchorId: "a",
            cause: "GRACE_DEADLINE_MISS",
            now: 1_000,
            stageIntervalMs: STAGE_INTERVAL_MS,
          });
          const id = opened.incidentId;
          const rec = store.incidents.get(id)!;
          rec.status = terminalStatus;
          const stageBefore = rec.stage;
          const auditLenBefore = rec.auditTrail.length;

          for (let t = 0; t < tickCount; t++) {
            const outcome = await advanceIncident(store.deps, {
              incidentId: id,
              now: 2_000 + t,
              stageIntervalMs: STAGE_INTERVAL_MS,
            });
            expect(outcome.advanced).toBe(false);
          }

          expect(rec.stage).toBe(stageBefore);
          expect(rec.auditTrail.length).toBe(auditLenBefore);
        },
      ),
      { numRuns: 200 },
    );
  });
});

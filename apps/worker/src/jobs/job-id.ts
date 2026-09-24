/**
 * Deterministic BullMQ `jobId` scheme.
 *
 * BullMQ deduplicates and cancels jobs by `jobId`. The escalation FSM
 * (design "Escalation State Machine" → "Job design") relies on *deterministic*
 * ids so that:
 *   - re-enqueuing the same logical job is idempotent (BullMQ ignores a second
 *     `add` with an existing `jobId`), and
 *   - the resolution worker can cancel a pending delayed stage job purely from
 *     the incident id + target stage, with no bookkeeping (design
 *     "Auto-resolution cancellation").
 *
 * The canonical scheme from the design is `incident:<id>:stageN`. Sibling
 * schemes for the other queues follow the same `namespace:<id>:<discriminator>`
 * shape so ids never collide across queues and stay greppable in Redis.
 *
 * These helpers are pure and stable: identical inputs always yield an
 * identical string. They are the single source of truth for job ids — later
 * tasks (8.2 rhythm engine, 10.x escalation FSM / resolution, 14.x vitality)
 * MUST derive ids through them rather than hand-formatting strings.
 */

/** The four escalation stages, as their numeric ordinal (design R12.5). */
export type StageNumber = 1 | 2 | 3 | 4;

const INCIDENT_NS = "incident" as const;
const RHYTHM_NS = "rhythm" as const;
const VITALITY_NS = "vitality" as const;

/**
 * Guard against ids that would break the `:`-delimited scheme. Incident and
 * anchor ids are Prisma cu/uuid strings in practice (no colons/whitespace);
 * this keeps the scheme unambiguous and fails loudly on bad input.
 */
function assertIdSegment(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`jobId ${label} must be a non-empty string`);
  }
  if (/[:\s]/.test(value)) {
    throw new Error(
      `jobId ${label} must not contain ':' or whitespace (got "${value}")`,
    );
  }
}

/**
 * Deterministic id for the delayed `advance` job that moves an incident *into*
 * the given stage — the canonical `incident:<id>:stageN` scheme.
 *
 * Example: `escalationJobId("abc", 2)` → `"incident:abc:stage2"`.
 */
export function escalationJobId(incidentId: string, stage: StageNumber): string {
  assertIdSegment(incidentId, "incidentId");
  return `${INCIDENT_NS}:${incidentId}:stage${stage}`;
}

/**
 * Deterministic id for the nightly per-Anchor `grace-check` scheduled by the
 * `rhythm-eval` queue (design R4.3). `serviceDay` is the local calendar day the
 * check belongs to (e.g. `2025-01-31`) so re-computing the rhythm for the same
 * day is idempotent.
 *
 * Example: `graceCheckJobId("anchor1", "2025-01-31")` →
 * `"rhythm:anchor1:grace-check:2025-01-31"`.
 */
export function graceCheckJobId(anchorId: string, serviceDay: string): string {
  assertIdSegment(anchorId, "anchorId");
  assertIdSegment(serviceDay, "serviceDay");
  return `${RHYTHM_NS}:${anchorId}:grace-check:${serviceDay}`;
}

/**
 * Deterministic id for a Vitality Pulse emission tied to a confirmed morning
 * routine (design R7/R22). Keyed on anchor + service day so one confirmed
 * morning yields at most one pulse job.
 *
 * Example: `vitalityPulseJobId("anchor1", "2025-01-31")` →
 * `"vitality:anchor1:pulse:2025-01-31"`.
 */
export function vitalityPulseJobId(anchorId: string, serviceDay: string): string {
  assertIdSegment(anchorId, "anchorId");
  assertIdSegment(serviceDay, "serviceDay");
  return `${VITALITY_NS}:${anchorId}:pulse:${serviceDay}`;
}

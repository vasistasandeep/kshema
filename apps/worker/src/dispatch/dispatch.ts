/**
 * Dispatch worker core logic (R31, R21.12, task 12.2).
 *
 * The `dispatch` queue is the telephony/messaging fan-out layer. The escalation
 * FSM (task 10.1) enqueues a per-stage {@link StageSideEffect} onto this queue;
 * this module turns that effect into concrete carrier calls behind the injected
 * {@link CarrierAdapter} (task 12.1), and — for Stage-4 voice — runs the AMD +
 * Interactive_Voice_Handshake with retry/failover (R31) while appending the
 * DTMF timestamp + AMD diagnostic to the incident audit trail (R31.4).
 *
 * Everything that touches the outside world lives behind an injectable seam so
 * the unit tests stay hermetic:
 *   - {@link CarrierAdapter} — the gateway (a {@link MockCarrierAdapter} with a
 *     scripted `VoicePlan` in tests / Simulation_Mode).
 *   - {@link DispatchDeps.appendAudit} — persists one audit entry onto
 *     `SafetyIncident.auditTrail` (Prisma read-modify-write in production, a spy
 *     in tests).
 *   - {@link RetryPolicy} — computes exponential backoff *values*; it does not
 *     sleep. The BullMQ-facing config is derived from the same policy
 *     ({@link toBullMqRetryOptions}) so retry timing never depends on real
 *     timers inside this module.
 *
 * Scope (task 12.2): the voice handshake, retry/failover across an ordered
 * contact list, and audit-trail accrual. The *content* of the hyperlocal
 * message and contact-list assembly from `HyperlocalContactProfile` is task
 * 13.1; here the ordered contact list is an input.
 */

import {
  HANDSHAKE_CONFIRM_DIGIT,
  HANDSHAKE_GATHER_TIMEOUT_SEC,
  isHandshakeAcknowledged,
  type AmdCode,
  type CarrierAdapter,
  type VoiceHandshakeCall,
  type VoiceHandshakeResult,
} from "../carrier/index.js";

/** A single contact in the ordered Stage-4 failover list (R31.3). */
export interface DispatchContact {
  /** Stable id (Observer/gate/neighbor id) for audit correlation. */
  id: string;
  /** E.164 phone number to dial. */
  phone: string;
  /** Human-facing label (e.g. "Primary Observer", "Neighbor"); optional. */
  label?: string;
}

/**
 * An audit entry appended to `SafetyIncident.auditTrail` for a voice-handshake
 * attempt (R31.4). Distinct from the escalation FSM's stage entry: this carries
 * the DTMF confirmation timestamp and the carrier AMD diagnostic code.
 */
export interface VoiceHandshakeAuditEntry {
  /** Discriminator so audit consumers can separate handshake from stage entries. */
  kind: "voice_handshake";
  /** The incident this attempt belongs to. */
  incidentId: string;
  /** The contact dialed for this attempt. */
  contactId: string;
  /** 1-based attempt ordinal across the failover sequence. */
  attempt: number;
  /** Whether this attempt was acknowledged (DTMF '1' within 15s). */
  acknowledged: boolean;
  /** Carrier AMD diagnostic code (R31.4). */
  amdCode: AmdCode;
  /** DTMF confirmation timestamp in epoch-ms, when a confirming tone arrived (R31.4). */
  dtmfAtMs?: number;
  /** The DTMF digit pressed, if any. */
  dtmfDigit?: string;
  /** When this audit entry was recorded (epoch-ms). */
  at: number;
}

/**
 * An exponential-backoff retry policy. Pure: it computes delay *values*; it
 * never sleeps, so callers (and tests) stay deterministic and timer-free. The
 * BullMQ config is derived from the same numbers via {@link toBullMqRetryOptions}.
 */
export interface RetryPolicy {
  /** Total attempts allowed per contact before failing over (>= 1). */
  maxAttemptsPerContact: number;
  /** Base delay in ms for the first retry. */
  baseDelayMs: number;
  /** Multiplier applied per retry (exponential base; typically 2). */
  factor: number;
  /** Upper bound on any single computed delay (ms). */
  maxDelayMs: number;
}

/** A sensible default retry policy for Stage-4 voice dispatch (R31.3). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttemptsPerContact: 2,
  baseDelayMs: 5_000,
  factor: 2,
  maxDelayMs: 60_000,
};

/**
 * Exponential backoff delay for a given zero-based retry index, clamped to
 * `maxDelayMs`. `retryIndex = 0` is the delay before the *first* retry (i.e.
 * after attempt 1 failed). Pure and timer-free.
 */
export function backoffDelayMs(policy: RetryPolicy, retryIndex: number): number {
  if (retryIndex < 0) {
    throw new Error(`retryIndex must be >= 0 (got ${retryIndex})`);
  }
  const raw = policy.baseDelayMs * Math.pow(policy.factor, retryIndex);
  return Math.min(raw, policy.maxDelayMs);
}

/**
 * Translate a {@link RetryPolicy} into BullMQ job options so the queue-level
 * retry config is derived from the exact same numbers the pure logic uses. The
 * escalation/dispatch producer wiring (`app.ts`/`server.ts`) spreads this onto
 * `queue.add(...)`. Kept here (not hidden in wiring) so it is unit-testable.
 */
export function toBullMqRetryOptions(policy: RetryPolicy): {
  attempts: number;
  backoff: { type: "exponential"; delay: number };
} {
  return {
    attempts: policy.maxAttemptsPerContact,
    backoff: { type: "exponential", delay: policy.baseDelayMs },
  };
}

/** Injectable side-effect seams for the dispatch worker. */
export interface DispatchDeps {
  /** The carrier gateway (mock in tests / Simulation_Mode). */
  carrier: CarrierAdapter;
  /**
   * Append one entry to `SafetyIncident.auditTrail`. Production wiring performs
   * the Prisma read-modify-write (JSON array append); tests observe the call.
   */
  appendAudit: (entry: VoiceHandshakeAuditEntry) => Promise<void>;
  /** Injectable clock (epoch-ms); defaults to `Date.now`. */
  now?: () => number;
  /** Retry policy; defaults to {@link DEFAULT_RETRY_POLICY}. */
  retryPolicy?: RetryPolicy;
  /**
   * Optional hook invoked with the computed backoff delay before each retry
   * attempt *within* a contact. It does NOT sleep by default (kept timer-free);
   * production wiring can await a real delay here if in-process retry is used,
   * though the primary retry path is BullMQ's queue-level backoff.
   */
  onBackoff?: (delayMs: number, retryIndex: number) => Promise<void> | void;
}

/** Per-attempt record produced while running the handshake sequence. */
export interface VoiceAttempt {
  /** 1-based attempt ordinal across the whole failover sequence. */
  attempt: number;
  /** The contact dialed. */
  contact: DispatchContact;
  /** Zero-based retry index within this contact (0 = first try). */
  retryIndex: number;
  /** The handshake result the carrier returned. */
  result: VoiceHandshakeResult;
}

/** Outcome of {@link runVoiceHandshakeDispatch}. */
export interface VoiceDispatchOutcome {
  /** True iff some contact acknowledged (DTMF '1' within 15s) (R31). */
  acknowledged: boolean;
  /** The contact that acknowledged, when `acknowledged` is true. */
  acknowledgedBy?: DispatchContact;
  /** Every attempt made, in order (includes retries and failovers). */
  attempts: VoiceAttempt[];
}

/** Inputs to run a Stage-4 voice-handshake dispatch (R31). */
export interface VoiceDispatchInput {
  incidentId: string;
  /** Ordered contact list; failover walks it front-to-back (R31.3). */
  contacts: readonly DispatchContact[];
  /** Spoken message text (content assembly is task 13.1; passed in here). */
  messageText: string;
}

/** Build the provider-neutral handshake call for a contact (always AMD + gather '1'/15s). */
function buildCall(
  contact: DispatchContact,
  messageText: string,
): VoiceHandshakeCall {
  return {
    to: contact.phone,
    messageText,
    amd: true,
    gatherDigit: HANDSHAKE_CONFIRM_DIGIT,
    gatherTimeoutSec: HANDSHAKE_GATHER_TIMEOUT_SEC,
  };
}

/**
 * Run the Stage-4 voice-handshake dispatch with retry + failover (R31).
 *
 * For each contact in order, place up to `maxAttemptsPerContact` voice calls.
 * An attempt is *acknowledged* iff the carrier reports `acknowledged` — i.e.
 * DTMF '1' arrived within 15s (defense-in-depth: also re-checked via
 * {@link isHandshakeAcknowledged} on the raw digits). On acknowledgment the
 * sequence STOPS immediately (no further contacts dialed). On an unacknowledged
 * attempt (voicemail / silence / timeout) the worker retries the same contact
 * with exponential backoff, then fails over to the NEXT contact once this
 * contact's attempts are exhausted (R31.3).
 *
 * Every attempt — acknowledged or not — appends a {@link VoiceHandshakeAuditEntry}
 * carrying the DTMF timestamp + AMD diagnostic to the incident audit trail
 * (R31.4).
 */
export async function runVoiceHandshakeDispatch(
  deps: DispatchDeps,
  input: VoiceDispatchInput,
): Promise<VoiceDispatchOutcome> {
  const now = deps.now ?? (() => Date.now());
  const policy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const maxPerContact = Math.max(1, policy.maxAttemptsPerContact);

  const attempts: VoiceAttempt[] = [];
  let attemptOrdinal = 0;

  for (const contact of input.contacts) {
    for (let retryIndex = 0; retryIndex < maxPerContact; retryIndex++) {
      // Apply exponential backoff before every retry within a contact (not
      // before the first try). Kept timer-free: `onBackoff` decides whether to
      // actually wait; the default no-ops.
      if (retryIndex > 0 && deps.onBackoff) {
        await deps.onBackoff(backoffDelayMs(policy, retryIndex - 1), retryIndex - 1);
      }

      attemptOrdinal += 1;
      const result = await deps.carrier.placeVoiceWithHandshake(
        buildCall(contact, input.messageText),
      );

      // Authoritative acknowledgment per R31; re-derive from raw digits as a
      // guard so a carrier can't falsely mark an emergency acknowledged.
      const acknowledged =
        result.acknowledged &&
        isHandshakeAcknowledged({
          dtmfDigit: result.dtmfDigit,
          dtmfDelaySec: result.dtmfDelaySec,
          gatherTimeoutSec: HANDSHAKE_GATHER_TIMEOUT_SEC,
        });

      attempts.push({ attempt: attemptOrdinal, contact, retryIndex, result });

      // Append the DTMF timestamp + AMD diagnostic to the audit trail (R31.4).
      const entry: VoiceHandshakeAuditEntry = {
        kind: "voice_handshake",
        incidentId: input.incidentId,
        contactId: contact.id,
        attempt: attemptOrdinal,
        acknowledged,
        amdCode: result.amdCode,
        at: now(),
        ...(result.dtmfAtMs !== undefined ? { dtmfAtMs: result.dtmfAtMs } : {}),
        ...(result.dtmfDigit !== undefined ? { dtmfDigit: result.dtmfDigit } : {}),
      };
      await deps.appendAudit(entry);

      if (acknowledged) {
        // Human confirmed presence: stop failover immediately (R31).
        return { acknowledged: true, acknowledgedBy: contact, attempts };
      }
      // Unacknowledged → retry this contact, else fall through to next contact.
    }
  }

  // Exhausted every contact without acknowledgment (R31.3).
  return { acknowledged: false, attempts };
}

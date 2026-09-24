/**
 * Unit tests for the dispatch worker core (R31, R21.12, task 12.2).
 *
 * All hermetic: the carrier is a MockCarrierAdapter driven by a scripted
 * VoicePlan (no wall-clock timing), the audit append is a spy, and the retry
 * backoff is asserted purely (no real timers).
 */
import { describe, expect, it, vi } from "vitest";

import { MockCarrierAdapter } from "../carrier/index.js";
import {
  backoffDelayMs,
  runVoiceHandshakeDispatch,
  toBullMqRetryOptions,
  DEFAULT_RETRY_POLICY,
  type DispatchContact,
  type RetryPolicy,
  type VoiceHandshakeAuditEntry,
} from "./dispatch.js";

const NOW = 1_700_000_000_000;

const CONTACTS: DispatchContact[] = [
  { id: "primary-observer", phone: "+911111111111", label: "Primary Observer" },
  { id: "gate", phone: "+912222222222", label: "Gate" },
  { id: "neighbor", phone: "+913333333333", label: "Neighbor" },
];

function makeDeps(carrier: MockCarrierAdapter, overrides?: Partial<Parameters<typeof runVoiceHandshakeDispatch>[0]>) {
  const audits: VoiceHandshakeAuditEntry[] = [];
  const appendAudit = vi.fn(async (e: VoiceHandshakeAuditEntry) => {
    audits.push(e);
  });
  const deps = {
    carrier,
    appendAudit,
    now: () => NOW,
    ...overrides,
  };
  return { deps, audits, appendAudit };
}

describe("runVoiceHandshakeDispatch (R31)", () => {
  it("acknowledged DTMF '1' within 15s stops failover and records dtmf timestamp + AMD code", async () => {
    // Primary observer presses '1' at 3s → acknowledged.
    const carrier = new MockCarrierAdapter({
      voicePlan: {
        mode: "fixed",
        outcome: { dtmfDigit: "1", dtmfDelaySec: 3, amdCode: "HUMAN", connectedAtMs: NOW },
      },
    });
    const { deps, audits } = makeDeps(carrier);

    const outcome = await runVoiceHandshakeDispatch(deps, {
      incidentId: "inc-1",
      contacts: CONTACTS,
      messageText: "please confirm",
    });

    expect(outcome.acknowledged).toBe(true);
    expect(outcome.acknowledgedBy?.id).toBe("primary-observer");
    // Only the first contact was dialed — no failover.
    expect(outcome.attempts).toHaveLength(1);
    expect(carrier.voiceCalls).toHaveLength(1);

    // Audit accrued the DTMF timestamp + AMD diagnostic (R31.4).
    expect(audits).toHaveLength(1);
    const entry = audits[0]!;
    expect(entry.acknowledged).toBe(true);
    expect(entry.amdCode).toBe("HUMAN");
    expect(entry.dtmfDigit).toBe("1");
    expect(entry.dtmfAtMs).toBe(NOW + 3_000);
    expect(entry.contactId).toBe("primary-observer");
    expect(entry.at).toBe(NOW);
  });

  it("DTMF arriving after 15s is NOT acknowledged and fails over", async () => {
    // digit '1' but at 16s → beyond the gather window → unacknowledged.
    const carrier = new MockCarrierAdapter({
      voicePlan: {
        mode: "queue",
        outcomes: [
          { dtmfDigit: "1", dtmfDelaySec: 16, amdCode: "TIMEOUT", connectedAtMs: NOW },
          // second contact acknowledges in time
          { dtmfDigit: "1", dtmfDelaySec: 2, amdCode: "HUMAN", connectedAtMs: NOW },
        ],
      },
    });
    const { deps } = makeDeps(carrier, {
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttemptsPerContact: 1 },
    });

    const outcome = await runVoiceHandshakeDispatch(deps, {
      incidentId: "inc-late",
      contacts: CONTACTS,
      messageText: "x",
    });

    expect(outcome.acknowledged).toBe(true);
    expect(outcome.acknowledgedBy?.id).toBe("gate");
    expect(outcome.attempts).toHaveLength(2);
  });

  it("voicemail / silence / timeout → unacknowledged → failover to next contact", async () => {
    const outcomes = [
      { amdCode: "MACHINE_START" as const }, // primary → voicemail
      { amdCode: "SILENCE" as const }, // gate → silence
      { dtmfDigit: "1", dtmfDelaySec: 4, amdCode: "HUMAN" as const, connectedAtMs: NOW }, // neighbor answers
    ];
    const carrier = new MockCarrierAdapter({
      voicePlan: { mode: "queue", outcomes },
    });
    const { deps, audits } = makeDeps(carrier, {
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttemptsPerContact: 1 },
    });

    const outcome = await runVoiceHandshakeDispatch(deps, {
      incidentId: "inc-fo",
      contacts: CONTACTS,
      messageText: "x",
    });

    expect(outcome.acknowledged).toBe(true);
    expect(outcome.acknowledgedBy?.id).toBe("neighbor");
    // All three contacts dialed in order.
    expect(outcome.attempts.map((a) => a.contact.id)).toEqual([
      "primary-observer",
      "gate",
      "neighbor",
    ]);
    // Audit trail accrues one entry per attempt with AMD codes (R31.4).
    expect(audits.map((a) => a.amdCode)).toEqual([
      "MACHINE_START",
      "SILENCE",
      "HUMAN",
    ]);
    expect(audits.filter((a) => a.acknowledged)).toHaveLength(1);
  });

  it("nobody acknowledges → outcome unacknowledged after exhausting every contact", async () => {
    const carrier = new MockCarrierAdapter({
      voicePlan: { mode: "fixed", outcome: { amdCode: "TIMEOUT" } },
    });
    const { deps, audits } = makeDeps(carrier, {
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttemptsPerContact: 1 },
    });

    const outcome = await runVoiceHandshakeDispatch(deps, {
      incidentId: "inc-none",
      contacts: CONTACTS,
      messageText: "x",
    });

    expect(outcome.acknowledged).toBe(false);
    expect(outcome.acknowledgedBy).toBeUndefined();
    expect(outcome.attempts).toHaveLength(3);
    expect(audits.every((a) => !a.acknowledged)).toBe(true);
  });

  it("retries the same contact with exponential backoff before failing over", async () => {
    // Primary: attempt1 TIMEOUT, attempt2 acknowledged.
    const carrier = new MockCarrierAdapter({
      voicePlan: {
        mode: "queue",
        outcomes: [
          { amdCode: "TIMEOUT" },
          { dtmfDigit: "1", dtmfDelaySec: 1, amdCode: "HUMAN", connectedAtMs: NOW },
        ],
      },
    });
    const backoffs: Array<{ delayMs: number; retryIndex: number }> = [];
    const { deps } = makeDeps(carrier, {
      retryPolicy: {
        maxAttemptsPerContact: 3,
        baseDelayMs: 1_000,
        factor: 2,
        maxDelayMs: 60_000,
      },
      onBackoff: (delayMs, retryIndex) => {
        backoffs.push({ delayMs, retryIndex });
      },
    });

    const outcome = await runVoiceHandshakeDispatch(deps, {
      incidentId: "inc-retry",
      contacts: CONTACTS,
      messageText: "x",
    });

    expect(outcome.acknowledged).toBe(true);
    expect(outcome.acknowledgedBy?.id).toBe("primary-observer");
    // Two attempts on the same contact.
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts.every((a) => a.contact.id === "primary-observer")).toBe(true);
    // One backoff applied before the 2nd attempt (retryIndex 0 → baseDelay).
    expect(backoffs).toEqual([{ delayMs: 1_000, retryIndex: 0 }]);
  });
});

describe("backoff policy (R21.12 exponential backoff)", () => {
  it("computes clamped exponential delays", () => {
    const policy: RetryPolicy = {
      maxAttemptsPerContact: 5,
      baseDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 5_000,
    };
    expect(backoffDelayMs(policy, 0)).toBe(1_000);
    expect(backoffDelayMs(policy, 1)).toBe(2_000);
    expect(backoffDelayMs(policy, 2)).toBe(4_000);
    // clamped at maxDelayMs
    expect(backoffDelayMs(policy, 3)).toBe(5_000);
    expect(backoffDelayMs(policy, 10)).toBe(5_000);
  });

  it("rejects a negative retry index", () => {
    expect(() => backoffDelayMs(DEFAULT_RETRY_POLICY, -1)).toThrow();
  });

  it("derives BullMQ retry options from the same policy", () => {
    expect(toBullMqRetryOptions(DEFAULT_RETRY_POLICY)).toEqual({
      attempts: DEFAULT_RETRY_POLICY.maxAttemptsPerContact,
      backoff: { type: "exponential", delay: DEFAULT_RETRY_POLICY.baseDelayMs },
    });
  });
});

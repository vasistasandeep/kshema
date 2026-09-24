/**
 * Integration tests for carrier dispatch with a mock carrier (task 12.4).
 *
 * These exercise the Stage-4 telephony flow END-TO-END *within the worker*:
 * a `dispatch` `stage_effect` job is fed through the real
 * {@link createDispatchProcessor} (not the pure `runVoiceHandshakeDispatch`
 * function directly), which drives a {@link MockCarrierAdapter} configured with
 * scripted `VoicePlan`s and appends handshake audit entries through a capturing
 * `appendAudit` spy. This mirrors the design's "Integration tests with mock
 * carrier adapters" section: the AMD handshake recording the DTMF timestamp +
 * AMD diagnostic code to the audit trail (R31.4), and — where naturally
 * exercisable in the worker — inbound WhatsApp reply resolution (R13.5).
 *
 * R13.5 (inbound WhatsApp reply resolution) note:
 *   The HTTP webhook path (Meta inbound reply → resolve) lives in apps/api
 *   (task 7.2 webhooks.ts) and is covered by that API-side test. Within the
 *   worker, the reply is delivered as an `incident.resolved` event carrying
 *   `source = WHATSAPP_RESPONSE` onto the `resolution` queue, which the
 *   resolution processor turns into a `resolveIncident` call
 *   (`WHATSAPP_RESPONSE` is a member of `AUTO_RESOLUTION_SOURCES`). Because that
 *   consumer path IS naturally exercisable here, we add a worker-side
 *   integration assertion that a WHATSAPP_RESPONSE `resolve` job drives
 *   `resolveIncident` (atomic OPEN→RESOLVED, source recorded, pending
 *   escalation jobs cancelled). The API HTTP surface remains task 7.2's
 *   responsibility; this file focuses on the carrier/AMD/audit integration.
 *
 * Everything is hermetic and timer-free: voice outcomes come from the injected
 * VoicePlan (never wall-clock timing), the audit append is a spy, and the
 * clock is injected.
 */
import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";

import { MockCarrierAdapter } from "../carrier/index.js";
import type { ProcessorContext } from "../jobs/registry.js";
import { escalationJobId } from "../jobs/job-id.js";
import {
  createResolutionProcessor,
  type ResolveJobData,
} from "../resolution/processor.js";
import type { ResolutionDeps } from "../resolution/resolve.js";
import { createDispatchProcessor, type DispatchJobData } from "./index.js";
import type {
  DispatchContact,
  VoiceHandshakeAuditEntry,
} from "./dispatch.js";

const NOW = 1_700_000_000_000;
const GATHER_TIMEOUT_SEC = 15;

const CONTACTS: DispatchContact[] = [
  { id: "primary-observer", phone: "+911111111111", label: "Primary Observer" },
  { id: "gate", phone: "+912222222222", label: "Gate" },
  { id: "neighbor", phone: "+913333333333", label: "Neighbor" },
];

/** A silent logger so the mock carrier's console.info doesn't spam test output. */
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Build a `stage_effect` hyperlocal_dispatch job for the dispatch processor. */
function hyperlocalJob(
  data: Partial<DispatchJobData> & { incidentId: string },
): Job {
  const payload: DispatchJobData = {
    incidentId: data.incidentId,
    stage: "STAGE_4_HYPERLOCAL_DISPATCH",
    kind: "hyperlocal_dispatch",
    contacts: data.contacts ?? CONTACTS,
    messageText: data.messageText ?? "please press 1 to confirm you are safe",
    ...(data.smsBody !== undefined ? { smsBody: data.smsBody } : {}),
  };
  // Only the `name`/`data` fields are read by the processor.
  return { name: "stage_effect", data: payload } as unknown as Job;
}

/** Wire the real dispatch processor over a mock carrier + capturing audit spy. */
function makeDispatchHarness(
  carrier: MockCarrierAdapter,
  retryPolicyMaxPerContact = 1,
) {
  const audits: VoiceHandshakeAuditEntry[] = [];
  const appendAudit = vi.fn(async (e: VoiceHandshakeAuditEntry) => {
    audits.push(e);
  });
  const processor = createDispatchProcessor({
    carrier,
    appendAudit,
    now: () => NOW,
    retryPolicy: {
      maxAttemptsPerContact: retryPolicyMaxPerContact,
      baseDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 60_000,
    },
  });
  const ctx: ProcessorContext = {
    prisma: {} as ProcessorContext["prisma"],
    logger: silentLogger,
  };
  return { processor, ctx, audits, appendAudit };
}

describe("carrier dispatch integration — AMD handshake audit trail (R31.4)", () => {
  it("records a DTMF timestamp + AMD code and acknowledges when '1' arrives within 15s", async () => {
    // Primary observer presses '1' at 4s (< 15s window) → human acknowledged.
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "fixed",
        outcome: {
          dtmfDigit: "1",
          dtmfDelaySec: 4,
          amdCode: "HUMAN",
          connectedAtMs: NOW,
        },
      },
    });
    const { processor, ctx, audits } = makeDispatchHarness(carrier);

    const result = (await processor(
      hyperlocalJob({ incidentId: "inc-ack" }),
      ctx,
    )) as { acknowledged: boolean; acknowledgedBy: string | null };

    // The handshake acknowledged and stopped at the first contact — no failover.
    expect(result.acknowledged).toBe(true);
    expect(result.acknowledgedBy).toBe("primary-observer");
    expect(carrier.voiceCalls).toHaveLength(1);
    // The carrier was actually asked for AMD + a gather-'1'/15s handshake (R31.1/31.2).
    const call = carrier.voiceCalls[0]!.call;
    expect(call.amd).toBe(true);
    expect(call.gatherDigit).toBe("1");
    expect(call.gatherTimeoutSec).toBe(GATHER_TIMEOUT_SEC);

    // One audit entry carrying the DTMF timestamp + AMD diagnostic (R31.4).
    expect(audits).toHaveLength(1);
    const entry = audits[0]!;
    expect(entry.kind).toBe("voice_handshake");
    expect(entry.incidentId).toBe("inc-ack");
    expect(entry.contactId).toBe("primary-observer");
    expect(entry.acknowledged).toBe(true);
    expect(entry.amdCode).toBe("HUMAN");
    expect(entry.dtmfDigit).toBe("1");
    // dtmfAtMs = connectedAtMs + delaySec*1000 (R31.4 DTMF confirmation timestamp).
    expect(entry.dtmfAtMs).toBe(NOW + 4_000);
  });

  it("records the AMD code for an unacknowledged voicemail/silence outcome and fails over", async () => {
    // Primary → voicemail greeting (MACHINE_START, no DTMF); gate answers.
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "queue",
        outcomes: [
          { amdCode: "MACHINE_START" }, // primary → voicemail: unacknowledged
          {
            dtmfDigit: "1",
            dtmfDelaySec: 2,
            amdCode: "HUMAN",
            connectedAtMs: NOW,
          }, // gate answers
        ],
      },
    });
    const { processor, ctx, audits } = makeDispatchHarness(carrier);

    const result = (await processor(
      hyperlocalJob({ incidentId: "inc-vm" }),
      ctx,
    )) as { acknowledged: boolean; acknowledgedBy: string | null };

    // Failed over from the voicemail to the next contact, which acknowledged.
    expect(result.acknowledged).toBe(true);
    expect(result.acknowledgedBy).toBe("gate");
    expect(carrier.voiceCalls).toHaveLength(2);

    // First (unacknowledged) audit entry records the voicemail AMD code with no DTMF.
    expect(audits).toHaveLength(2);
    const voicemail = audits[0]!;
    expect(voicemail.contactId).toBe("primary-observer");
    expect(voicemail.acknowledged).toBe(false);
    expect(voicemail.amdCode).toBe("MACHINE_START");
    expect(voicemail.dtmfDigit).toBeUndefined();
    expect(voicemail.dtmfAtMs).toBeUndefined();
    // The acknowledging entry carries the DTMF timestamp.
    const answered = audits[1]!;
    expect(answered.contactId).toBe("gate");
    expect(answered.acknowledged).toBe(true);
    expect(answered.amdCode).toBe("HUMAN");
    expect(answered.dtmfAtMs).toBe(NOW + 2_000);
  });

  it("late DTMF (after 15s) is treated as an unacknowledged TIMEOUT and recorded", async () => {
    // '1' pressed at 16s → outside the gather window → unacknowledged; nobody
    // else answers, so the whole ordered list is exhausted.
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "fixed",
        outcome: {
          dtmfDigit: "1",
          dtmfDelaySec: 16,
          amdCode: "TIMEOUT",
          connectedAtMs: NOW,
        },
      },
    });
    const { processor, ctx, audits } = makeDispatchHarness(carrier);

    const result = (await processor(
      hyperlocalJob({ incidentId: "inc-late" }),
      ctx,
    )) as { acknowledged: boolean };

    expect(result.acknowledged).toBe(false);
    // Every contact dialed once; none acknowledged.
    expect(carrier.voiceCalls).toHaveLength(CONTACTS.length);
    expect(audits).toHaveLength(CONTACTS.length);
    expect(audits.every((a) => a.acknowledged === false)).toBe(true);
    expect(audits.every((a) => a.amdCode === "TIMEOUT")).toBe(true);
  });

  it("accrues one audit entry per attempt across a multi-contact failover, each with its AMD code", async () => {
    // primary → voicemail, gate → silence, neighbor → human (DTMF '1' at 3s).
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "queue",
        outcomes: [
          { amdCode: "MACHINE_START" },
          { amdCode: "SILENCE" },
          {
            dtmfDigit: "1",
            dtmfDelaySec: 3,
            amdCode: "HUMAN",
            connectedAtMs: NOW,
          },
        ],
      },
    });
    const { processor, ctx, audits } = makeDispatchHarness(carrier);

    const result = (await processor(
      hyperlocalJob({ incidentId: "inc-fo" }),
      ctx,
    )) as { acknowledged: boolean; acknowledgedBy: string | null };

    expect(result.acknowledged).toBe(true);
    expect(result.acknowledgedBy).toBe("neighbor");

    // Exactly one audit entry per attempt, in contact order (R31.4 accrual).
    expect(audits).toHaveLength(3);
    expect(audits.map((a) => a.contactId)).toEqual([
      "primary-observer",
      "gate",
      "neighbor",
    ]);
    expect(audits.map((a) => a.amdCode)).toEqual([
      "MACHINE_START",
      "SILENCE",
      "HUMAN",
    ]);
    // Attempt ordinals increment across the whole failover sequence.
    expect(audits.map((a) => a.attempt)).toEqual([1, 2, 3]);
    // DTMF timestamp present only on the acknowledging attempt.
    expect(audits[0]!.dtmfAtMs).toBeUndefined();
    expect(audits[1]!.dtmfAtMs).toBeUndefined();
    expect(audits[2]!.dtmfAtMs).toBe(NOW + 3_000);
    // Exactly one acknowledged entry.
    expect(audits.filter((a) => a.acknowledged)).toHaveLength(1);
  });

  it("accrues an audit entry per retry attempt (same contact) before failing over", async () => {
    // Primary: attempt 1 SILENCE, attempt 2 (retry) HUMAN. Two attempts on the
    // same contact, each audited with its own AMD code.
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "queue",
        outcomes: [
          { amdCode: "SILENCE" },
          {
            dtmfDigit: "1",
            dtmfDelaySec: 1,
            amdCode: "HUMAN",
            connectedAtMs: NOW,
          },
        ],
      },
    });
    // maxAttemptsPerContact = 2 → the primary is retried once before failover.
    const { processor, ctx, audits } = makeDispatchHarness(carrier, 2);

    const result = (await processor(
      hyperlocalJob({ incidentId: "inc-retry" }),
      ctx,
    )) as { acknowledged: boolean; acknowledgedBy: string | null };

    expect(result.acknowledged).toBe(true);
    expect(result.acknowledgedBy).toBe("primary-observer");
    // Two attempts, both against the primary observer.
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.contactId === "primary-observer")).toBe(true);
    expect(audits.map((a) => a.amdCode)).toEqual(["SILENCE", "HUMAN"]);
    expect(audits.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("sends the priority SMS alongside the voice handshake when a body is provided", async () => {
    const carrier = new MockCarrierAdapter({
      logger: silentLogger,
      voicePlan: {
        mode: "fixed",
        outcome: {
          dtmfDigit: "1",
          dtmfDelaySec: 2,
          amdCode: "HUMAN",
          connectedAtMs: NOW,
        },
      },
    });
    const { processor, ctx } = makeDispatchHarness(carrier);

    await processor(
      hyperlocalJob({ incidentId: "inc-sms", smsBody: "Kshema alert: please respond" }),
      ctx,
    );

    // The SMS went to the first contact alongside the voice call.
    expect(carrier.sentMessages).toHaveLength(1);
    const sms = carrier.sentMessages[0]!;
    expect(sms.kind).toBe("sms");
    if (sms.kind === "sms") {
      expect(sms.msg.to).toBe(CONTACTS[0]!.phone);
      expect(sms.msg.body).toContain("Kshema alert");
    }
  });
});

describe("worker-side inbound WhatsApp reply resolution (R13.5)", () => {
  // The Meta inbound-reply HTTP webhook is covered by the API test (task 7.2).
  // Within the worker the reply arrives as an `incident.resolved` event with
  // source WHATSAPP_RESPONSE on the `resolution` queue; assert it drives
  // resolveIncident end-to-end through the real resolution processor.
  function makeResolutionHarness(startStatus: "OPEN" | "RESOLVED" = "OPEN") {
    const incident = { status: startStatus as "OPEN" | "RESOLVED" | "HANDED_OFF_SOS" };
    const cancelledJobIds: string[][] = [];
    const deps: ResolutionDeps = {
      conditionalTransition: vi.fn(async ({ toStatus }) => {
        if (incident.status !== "OPEN") return { affected: 0 };
        incident.status = toStatus;
        return { affected: 1 };
      }),
      cancelJobs: vi.fn(async (ids: string[]) => {
        cancelledJobIds.push(ids);
      }),
      releaseBlackBoxes: vi.fn(async () => undefined),
    };
    const processor = createResolutionProcessor({ ...deps, now: () => NOW });
    const ctx: ProcessorContext = {
      prisma: {} as ProcessorContext["prisma"],
      logger: silentLogger,
    };
    return { processor, ctx, deps, incident, cancelledJobIds };
  }

  function resolveJob(data: ResolveJobData): Job {
    return { name: "resolve", data } as unknown as Job;
  }

  it("a WHATSAPP_RESPONSE resolve event drives resolveIncident (OPEN→RESOLVED, jobs cancelled)", async () => {
    const { processor, ctx, deps, incident } = makeResolutionHarness("OPEN");

    const result = (await processor(
      resolveJob({ incidentId: "inc-wa", source: "WHATSAPP_RESPONSE" }),
      ctx,
    )) as { resolved: boolean; source: string; cancelledJobIds: string[] };

    expect(result.resolved).toBe(true);
    expect(result.source).toBe("WHATSAPP_RESPONSE");
    expect(incident.status).toBe("RESOLVED");
    expect(deps.conditionalTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "inc-wa",
        toStatus: "RESOLVED",
        resolutionSource: "WHATSAPP_RESPONSE",
        resolvedAt: NOW,
      }),
    );
    // Pending escalation advances are cancelled by deterministic jobId.
    expect(result.cancelledJobIds).toEqual([
      escalationJobId("inc-wa", 2),
      escalationJobId("inc-wa", 3),
      escalationJobId("inc-wa", 4),
    ]);
  });

  it("a duplicate WhatsApp reply after resolution is an idempotent no-op (R13.5/R13.8)", async () => {
    const { processor, ctx } = makeResolutionHarness("RESOLVED");

    const result = (await processor(
      resolveJob({ incidentId: "inc-wa", source: "WHATSAPP_RESPONSE" }),
      ctx,
    )) as { resolved: boolean; cancelledJobIds: string[] };

    expect(result.resolved).toBe(false);
    expect(result.cancelledJobIds).toEqual([]);
  });
});

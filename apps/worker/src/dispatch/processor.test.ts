/**
 * Unit tests for the `dispatch` queue processor wiring (R31, task 12.2).
 *
 * Uses a MockCarrierAdapter with a scripted VoicePlan + audit spy so the whole
 * open→stage-effect→carrier path is exercised without Redis/DB.
 */
import { describe, expect, it, vi } from "vitest";

import type { Job } from "bullmq";
import type { PrismaClient } from "@kshema/database";

import type { ProcessorContext } from "../jobs/registry.js";
import { MockCarrierAdapter } from "../carrier/index.js";
import {
  createDispatchProcessor,
  type DispatchJobData,
  type DispatchProcessorDeps,
} from "./processor.js";
import type { VoiceHandshakeAuditEntry } from "./dispatch.js";

const fakePrisma = {} as unknown as PrismaClient;
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: ProcessorContext = { prisma: fakePrisma, logger: silentLogger };
const NOW = 1_700_000_000_000;

function job(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

function makeDeps(carrier: MockCarrierAdapter, retryOverride = 1) {
  const audits: VoiceHandshakeAuditEntry[] = [];
  const deps: DispatchProcessorDeps = {
    carrier,
    appendAudit: vi.fn(async (e) => {
      audits.push(e);
    }),
    now: () => NOW,
    retryPolicy: {
      maxAttemptsPerContact: retryOverride,
      baseDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 60_000,
    },
  };
  return { deps, audits };
}

const CONTACTS = [
  { id: "primary-observer", phone: "+911111111111" },
  { id: "neighbor", phone: "+913333333333" },
];

describe("createDispatchProcessor", () => {
  it("STAGE_1 whatsapp_checkin sends a WhatsApp template", async () => {
    const carrier = new MockCarrierAdapter();
    const { deps } = makeDeps(carrier);
    const processor = createDispatchProcessor(deps);

    const data: DispatchJobData = {
      incidentId: "inc-1",
      stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
      kind: "whatsapp_checkin",
      to: "+919999999999",
      lang: "hi",
    };
    const res = (await processor(job("stage_effect", data), ctx)) as {
      dispatched: boolean;
      kind: string;
    };

    expect(res.dispatched).toBe(true);
    expect(res.kind).toBe("whatsapp_checkin");
    expect(carrier.sentMessages).toHaveLength(1);
    const sent = carrier.sentMessages[0]!;
    expect(sent.kind).toBe("whatsapp");
  });

  it("STAGE_4 hyperlocal_dispatch acknowledged stops failover and audits DTMF/AMD", async () => {
    const carrier = new MockCarrierAdapter({
      voicePlan: {
        mode: "fixed",
        outcome: { dtmfDigit: "1", dtmfDelaySec: 2, amdCode: "HUMAN", connectedAtMs: NOW },
      },
    });
    const { deps, audits } = makeDeps(carrier);
    const processor = createDispatchProcessor(deps);

    const data: DispatchJobData = {
      incidentId: "inc-4",
      stage: "STAGE_4_HYPERLOCAL_DISPATCH",
      kind: "hyperlocal_dispatch",
      contacts: CONTACTS,
      messageText: "emergency",
      smsBody: "priority SMS",
    };
    const res = (await processor(job("stage_effect", data), ctx)) as {
      acknowledged: boolean;
      acknowledgedBy: string | null;
      attempts: number;
    };

    expect(res.acknowledged).toBe(true);
    expect(res.acknowledgedBy).toBe("primary-observer");
    expect(res.attempts).toBe(1);
    // priority SMS also sent
    expect(carrier.sentMessages.some((m) => m.kind === "sms")).toBe(true);
    // audit recorded DTMF timestamp + AMD code
    expect(audits).toHaveLength(1);
    expect(audits[0]!.dtmfAtMs).toBe(NOW + 2_000);
    expect(audits[0]!.amdCode).toBe("HUMAN");
  });

  it("STAGE_4 voicemail on first contact fails over to the next", async () => {
    const carrier = new MockCarrierAdapter({
      voicePlan: {
        mode: "queue",
        outcomes: [
          { amdCode: "MACHINE_START" },
          { dtmfDigit: "1", dtmfDelaySec: 1, amdCode: "HUMAN", connectedAtMs: NOW },
        ],
      },
    });
    const { deps, audits } = makeDeps(carrier);
    const processor = createDispatchProcessor(deps);

    const data: DispatchJobData = {
      incidentId: "inc-fo",
      stage: "STAGE_4_HYPERLOCAL_DISPATCH",
      kind: "hyperlocal_dispatch",
      contacts: CONTACTS,
      messageText: "emergency",
    };
    const res = (await processor(job("stage_effect", data), ctx)) as {
      acknowledged: boolean;
      acknowledgedBy: string | null;
    };

    expect(res.acknowledged).toBe(true);
    expect(res.acknowledgedBy).toBe("neighbor");
    expect(audits.map((a) => a.amdCode)).toEqual(["MACHINE_START", "HUMAN"]);
  });

  it("STAGE_4 with no contacts is a no-op (content assembly is task 13.1)", async () => {
    const carrier = new MockCarrierAdapter();
    const { deps } = makeDeps(carrier);
    const processor = createDispatchProcessor(deps);

    const data: DispatchJobData = {
      incidentId: "inc-empty",
      stage: "STAGE_4_HYPERLOCAL_DISPATCH",
      kind: "hyperlocal_dispatch",
    };
    const res = (await processor(job("stage_effect", data), ctx)) as {
      dispatched: boolean;
      reason: string;
    };
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("no-contacts");
    expect(carrier.voiceCalls).toHaveLength(0);
  });

  it("device_chime / observer_silent_push do not call the carrier", async () => {
    const carrier = new MockCarrierAdapter();
    const { deps } = makeDeps(carrier);
    const processor = createDispatchProcessor(deps);

    for (const kind of ["device_chime", "observer_silent_push"] as const) {
      const data: DispatchJobData = {
        incidentId: "inc-x",
        stage: "STAGE_2_GENTLE_DEVICE_CHIME",
        kind,
      };
      const res = (await processor(job("stage_effect", data), ctx)) as {
        viaCarrier: boolean;
      };
      expect(res.viaCarrier).toBe(false);
    }
    expect(carrier.records).toHaveLength(0);
  });

  it("ignores an unknown job name", async () => {
    const carrier = new MockCarrierAdapter();
    const { deps } = makeDeps(carrier);
    const processor = createDispatchProcessor(deps);
    const res = (await processor(job("bogus", {}), ctx)) as { ignored: boolean };
    expect(res.ignored).toBe(true);
  });
});

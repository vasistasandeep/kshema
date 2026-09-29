/**
 * Production Prisma + BullMQ wiring for ALL Sentinel queues.
 *
 * The default processor registry ships no-op seams (safe to build without
 * Redis/DB). This module provides the real seams so the whole incident
 * lifecycle is persisted:
 *   - escalation: open/advance a real SafetyIncident + schedule next stage
 *   - resolution: atomic OPEN->RESOLVED / HANDED_OFF_SOS + cancel pending jobs
 *   - dispatch:   append carrier audit entries onto the incident audit trail
 *   - vitality:   VitalityPulseLog insert + VitalityStreak upsert + observers
 */
import type { Queue } from "bullmq";
import type { PrismaClient, IncidentStage, ResolutionSource } from "@kshema/database";
import { createEscalationProcessor, type EscalationProcessorDeps } from "../escalation/processor.js";
import type { AuditEntry, IncidentSnapshot, ScheduledAdvance, StageSideEffect } from "../escalation/fsm.js";
import type { ResolutionDeps } from "../resolution/resolve.js";
import type { DispatchProcessorDeps } from "../dispatch/processor.js";
import type { VitalityProcessorDeps } from "../vitality/processor.js";
import { MockCarrierAdapter } from "../carrier/mock-carrier-adapter.js";
import { emptyStreakState, type StreakState } from "../vitality/streak.js";

export interface Wiring {
  prisma: PrismaClient;
  escalationQueue: Queue;
  dispatchQueue: Queue;
  stageIntervalMs?: number;
}

// ---------------- Escalation ----------------
export function buildPrismaEscalationDeps(w: Wiring): EscalationProcessorDeps {
  const { prisma, escalationQueue, stageIntervalMs } = w;
  return {
    createIncident: async (input) => {
      const row = await prisma.safetyIncident.create({
        data: {
          circleId: input.circleId,
          anchorId: input.anchorId,
          stage: "STAGE_1_CONVERSATIONAL_WHATSAPP" as IncidentStage,
          status: "OPEN",
          simulated: input.simulated ?? false,
          auditTrail: input.auditTrail as unknown as object,
        },
        select: { id: true },
      });
      return { id: row.id };
    },
    readIncident: async (incidentId): Promise<IncidentSnapshot | null> => {
      const row = await prisma.safetyIncident.findUnique({
        where: { id: incidentId },
        select: { id: true, stage: true, status: true },
      });
      return row ? { id: row.id, stage: row.stage, status: row.status } : null;
    },
    applyAdvance: async ({ incidentId, stage, entry }) => {
      const row = await prisma.safetyIncident.findUnique({
        where: { id: incidentId }, select: { auditTrail: true },
      });
      const trail = Array.isArray(row?.auditTrail) ? (row!.auditTrail as unknown as AuditEntry[]) : [];
      trail.push(entry);
      await prisma.safetyIncident.update({
        where: { id: incidentId },
        data: { stage, auditTrail: trail as unknown as object },
      });
    },
    scheduleAdvance: async (advance: ScheduledAdvance) => {
      await escalationQueue.add("advance", advance.data, { jobId: advance.jobId, delay: advance.delayMs });
    },
    performSideEffect: async (_effect: StageSideEffect) => {
      // Stage side-effects (WhatsApp/chime/push/hyperlocal) are dispatched via
      // the dispatch queue by the FSM's own enqueue; the transition itself is
      // already persisted. No-op here to avoid enqueuing an unrecognized job.
    },
    ...(stageIntervalMs !== undefined ? { stageIntervalMs } : {}),
  };
}

// ---------------- Resolution ----------------
export function buildPrismaResolutionDeps(w: Wiring): ResolutionDeps {
  const { prisma, escalationQueue } = w;
  return {
    conditionalTransition: async ({ incidentId, toStatus, resolutionSource, resolvedAt }) => {
      const res = await prisma.safetyIncident.updateMany({
        where: { id: incidentId, status: "OPEN" },
        data: { status: toStatus, resolutionSource: resolutionSource as ResolutionSource, resolvedAt: new Date(resolvedAt) },
      });
      return { affected: res.count };
    },
    cancelJobs: async (jobIds: string[]) => {
      await Promise.all(jobIds.map((id) => escalationQueue.remove(id).catch(() => undefined)));
    },
    releaseBlackBoxes: async ({ circleId, anchorId }) => {
      await prisma.encryptedBlackBox.updateMany({
        where: { circleId, anchorId, released: false },
        data: { released: true },
      });
    },
  };
}

// ---------------- Dispatch ----------------
export function buildPrismaDispatchDeps(w: Wiring): DispatchProcessorDeps {
  const { prisma } = w;
  return {
    carrier: new MockCarrierAdapter(),
    appendAudit: async (entry) => {
      const incidentId = (entry as { incidentId?: string }).incidentId;
      if (!incidentId) return;
      const row = await prisma.safetyIncident.findUnique({ where: { id: incidentId }, select: { auditTrail: true } });
      const trail = Array.isArray(row?.auditTrail) ? (row!.auditTrail as unknown as unknown[]) : [];
      trail.push(entry as unknown);
      await prisma.safetyIncident.update({ where: { id: incidentId }, data: { auditTrail: trail as unknown as object } });
    },
  };
}

// ---------------- Vitality ----------------
export function buildPrismaVitalityDeps(w: Wiring): VitalityProcessorDeps {
  const { prisma } = w;
  return {
    loadAnchorProfile: async (anchorId) => {
      const u = await prisma.user.findUnique({ where: { id: anchorId }, select: { preferredName: true, timezone: true } });
      return { anchorId, preferredName: u?.preferredName ?? null, timezone: u?.timezone ?? "Asia/Kolkata" };
    },
    listObservers: async (circleId) => {
      const members = await prisma.circleMember.findMany({
        where: { circleId, role: { in: ["OBSERVER", "MUTUAL"] } },
        select: { userId: true, user: { select: { pushTokens: true } } },
      });
      return members.map((m) => ({ observerId: m.userId, pushTokens: m.user?.pushTokens ?? [] }));
    },
    recordPulseLog: async (input) => {
      await prisma.vitalityPulseLog.create({
        data: {
          circleId: input.circleId,
          anchorId: input.anchorId,
          confirmedAt: new Date((input as { confirmedAtMillis?: number }).confirmedAtMillis ?? Date.now()),
          context: ((input as { context?: object }).context ?? {}) as object,
        },
      });
    },
    deliverPulse: async () => { /* push transport fulfilled by mobile/push task */ },
    resolveTimezone: async (input: { circleId: string; anchorId: string }) => {
      const u = await prisma.user.findUnique({ where: { id: input.anchorId }, select: { timezone: true } });
      return u?.timezone ?? "Asia/Kolkata";
    },
    loadStreak: async (circleId): Promise<StreakState> => {
      const s = await prisma.vitalityStreak.findUnique({ where: { circleId } });
      if (!s) return emptyStreakState();
      return {
        count: s.count,
        lastConfirmedDay: s.lastConfirmedDay ?? null,
        freezeUntil: s.freezeUntil ? s.freezeUntil.toISOString().slice(0, 10) : null,
      } as StreakState;
    },
    saveStreak: async (circleId, state) => {
      await prisma.vitalityStreak.upsert({
        where: { circleId },
        create: {
          circleId, count: state.count,
          lastConfirmedDay: state.lastConfirmedDay ?? null,
          freezeUntil: state.freezeUntil ? new Date(state.freezeUntil + "T00:00:00Z") : null,
        },
        update: {
          count: state.count,
          lastConfirmedDay: state.lastConfirmedDay ?? null,
          freezeUntil: state.freezeUntil ? new Date(state.freezeUntil + "T00:00:00Z") : null,
        },
      });
    },
  };
}

export function buildEscalationProcessorFromWiring(w: Wiring) {
  return createEscalationProcessor(buildPrismaEscalationDeps(w));
}

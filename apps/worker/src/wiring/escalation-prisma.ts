/**
 * Production Prisma + BullMQ wiring for the escalation queue.
 *
 * The default processor registry ships no-op escalation seams (safe to build
 * without Redis/DB). This module provides the real seams so that opening an
 * incident persists a SafetyIncident row in Postgres, stage advances update it
 * and append to the audit trail, and the next delayed advance is enqueued onto
 * the live escalation queue. This is what makes the Observer dashboard reflect
 * ESCALATING from a real trigger.
 */
import type { Queue } from "bullmq";
import type { PrismaClient, IncidentStage } from "@kshema/database";
import { createEscalationProcessor, type EscalationProcessorDeps } from "../escalation/processor.js";
import type { AuditEntry, IncidentSnapshot, ScheduledAdvance, StageSideEffect } from "../escalation/fsm.js";

export interface PrismaEscalationWiring {
  prisma: PrismaClient;
  escalationQueue: Queue;
  dispatchQueue: Queue;
  stageIntervalMs?: number;
}

export function buildPrismaEscalationDeps(w: PrismaEscalationWiring): EscalationProcessorDeps {
  const { prisma, escalationQueue, dispatchQueue, stageIntervalMs } = w;
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
        where: { id: incidentId },
        select: { auditTrail: true },
      });
      const trail = Array.isArray(row?.auditTrail) ? (row!.auditTrail as unknown as AuditEntry[]) : [];
      trail.push(entry);
      await prisma.safetyIncident.update({
        where: { id: incidentId },
        data: { stage, auditTrail: trail as unknown as object },
      });
    },
    scheduleAdvance: async (advance: ScheduledAdvance) => {
      await escalationQueue.add("advance", advance.data, {
        jobId: advance.jobId,
        delay: advance.delayMs,
      });
    },
    performSideEffect: async (_effect: StageSideEffect) => {
      // Dispatch fan-out (WhatsApp/chime/push/hyperlocal) is a separate wiring
      // task; the stage transition itself is already persisted. No-op here so
      // we never enqueue an unrecognized dispatch job.
    },
    ...(stageIntervalMs !== undefined ? { stageIntervalMs } : {}),
  };
}

export function buildPrismaEscalationProcessor(w: PrismaEscalationWiring) {
  return createEscalationProcessor(buildPrismaEscalationDeps(w));
}

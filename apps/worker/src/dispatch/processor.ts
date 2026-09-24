/**
 * `dispatch` queue processor wiring (task 12.2).
 *
 * Glues the pure dispatch logic (`dispatch.ts`) to the worker's
 * {@link JobProcessor} contract while keeping the carrier gateway and audit
 * append behind {@link DispatchDeps}. The escalation FSM (task 10.1) enqueues a
 * {@link StageSideEffect} onto this queue for each stage; this processor turns
 * that into concrete carrier calls:
 *
 *   - `whatsapp_checkin`      (STAGE_1) → `carrier.sendWhatsApp`
 *   - `device_chime`          (STAGE_2) → currently a device push (no carrier);
 *                                          logged, kept for task 13.x wiring.
 *   - `observer_silent_push`  (STAGE_3) → observer silent push (no carrier);
 *                                          logged, kept for task 13.x wiring.
 *   - `hyperlocal_dispatch`   (STAGE_4) → priority SMS + the AMD + DTMF
 *                                          voice handshake with retry/failover
 *                                          across the ordered contact list (R31).
 *
 * The default deps are safe no-op/log seams so the registry can be constructed
 * without Redis/DB; production wiring (`app.ts`/`server.ts`) overrides them with
 * a live/mock carrier and a Prisma-backed audit append, and tests inject a
 * {@link MockCarrierAdapter} with a scripted `VoicePlan` plus spies.
 *
 * Scope note (task 12.2): STAGE_4 message *content* and contact-list assembly
 * from `HyperlocalContactProfile` is task 13.1. This processor implements the
 * handshake/retry/failover/audit machinery and accepts the ordered contact list
 * (and message text) on the job payload; when absent it logs and no-ops rather
 * than inventing content.
 */

import type { Job } from "bullmq";

import type { JobProcessor, ProcessorContext } from "../jobs/registry.js";
import type { StageSideEffect } from "../escalation/fsm.js";
import {
  runVoiceHandshakeDispatch,
  type DispatchContact,
  type DispatchDeps,
  type VoiceDispatchOutcome,
} from "./dispatch.js";

/** Job names the `dispatch` queue understands. */
export type DispatchJobName = "stage_effect";

/**
 * Payload of a `stage_effect` dispatch job — the escalation FSM's
 * {@link StageSideEffect} plus the runtime detail the carrier calls need.
 *
 * `contacts`/`messageText`/`smsBody` are populated by the STAGE_4 producer
 * (task 13.1 assembles them from `HyperlocalContactProfile`). For STAGE_1 the
 * `whatsAppTemplate`/`lang` drive the check-in send.
 */
export interface DispatchJobData extends StageSideEffect {
  /** WhatsApp template id for STAGE_1 check-in (defaults applied when absent). */
  whatsAppTemplate?: string;
  /** BCP-47 language for the WhatsApp/voice message. */
  lang?: string;
  /** Recipient phone for the STAGE_1 check-in / STAGE_2 chime target. */
  to?: string;
  /** Ordered failover contact list for STAGE_4 voice handshake (R31.3). */
  contacts?: DispatchContact[];
  /** Spoken message text for the STAGE_4 voice handshake. */
  messageText?: string;
  /** Priority SMS body sent alongside the STAGE_4 voice handshake. */
  smsBody?: string;
}

/** Dependencies for the dispatch processor. */
export type DispatchProcessorDeps = DispatchDeps;

const DEFAULT_WHATSAPP_TEMPLATE = "checkin_stage1";
const DEFAULT_LANG = "en";

/**
 * Build the `dispatch` queue processor from injectable deps. Pure w.r.t. the
 * seams in `deps` (carrier + audit append), so tests exercise the full
 * acknowledged / voicemail-failover / audit-accrual behavior with a
 * {@link MockCarrierAdapter} and spies, never touching Redis/DB.
 */
export function createDispatchProcessor(
  deps: DispatchProcessorDeps,
): JobProcessor {
  return async (job: Job, ctx: ProcessorContext) => {
    const name = job.name as DispatchJobName;
    if (name !== "stage_effect") {
      ctx.logger.warn(`[worker:dispatch] unknown job name "${job.name}"`);
      return { ignored: true, jobName: job.name };
    }

    const data = job.data as DispatchJobData;
    switch (data.kind) {
      case "whatsapp_checkin": {
        if (!data.to) {
          ctx.logger.warn(
            `[worker:dispatch] whatsapp_checkin for ${data.incidentId} missing "to"; no-op`,
          );
          return { dispatched: false, kind: data.kind, reason: "missing-to" };
        }
        const res = await deps.carrier.sendWhatsApp({
          to: data.to,
          template: data.whatsAppTemplate ?? DEFAULT_WHATSAPP_TEMPLATE,
          lang: data.lang ?? DEFAULT_LANG,
        });
        ctx.logger.info(
          `[worker:dispatch] STAGE_1 WhatsApp check-in for ${data.incidentId} accepted=${res.accepted}`,
        );
        return { dispatched: res.accepted, kind: data.kind };
      }

      case "device_chime":
      case "observer_silent_push": {
        // Device chime (R12.2) and observer silent push (R12.3) are delivered
        // via APNs/FCM push, not the carrier gateway; the push side lives in
        // the API/mobile layers. Nothing to send through CarrierAdapter here.
        ctx.logger.info(
          `[worker:dispatch] ${data.kind} for ${data.incidentId} — push-only, no carrier send`,
        );
        return { dispatched: true, kind: data.kind, viaCarrier: false };
      }

      case "hyperlocal_dispatch": {
        if (!data.contacts || data.contacts.length === 0) {
          ctx.logger.warn(
            `[worker:dispatch] hyperlocal_dispatch for ${data.incidentId} has no contacts; no-op (content assembly is task 13.1)`,
          );
          return {
            dispatched: false,
            kind: data.kind,
            reason: "no-contacts",
          };
        }

        // Priority SMS alongside the voice handshake, when a body is provided.
        if (data.smsBody && data.contacts[0]) {
          await deps.carrier.sendSms({
            to: data.contacts[0].phone,
            body: data.smsBody,
          });
        }

        const outcome: VoiceDispatchOutcome = await runVoiceHandshakeDispatch(
          deps,
          {
            incidentId: data.incidentId,
            contacts: data.contacts,
            messageText: data.messageText ?? "",
          },
        );

        ctx.logger.info(
          `[worker:dispatch] STAGE_4 voice handshake for ${data.incidentId}: ` +
            `acknowledged=${outcome.acknowledged}` +
            (outcome.acknowledgedBy
              ? ` by=${outcome.acknowledgedBy.id}`
              : "") +
            ` attempts=${outcome.attempts.length}`,
        );
        return {
          dispatched: true,
          kind: data.kind,
          acknowledged: outcome.acknowledged,
          acknowledgedBy: outcome.acknowledgedBy?.id ?? null,
          attempts: outcome.attempts.length,
        };
      }

      default: {
        ctx.logger.warn(
          `[worker:dispatch] unknown stage-effect kind "${(data as StageSideEffect).kind}"`,
        );
        return { ignored: true, kind: (data as StageSideEffect).kind };
      }
    }
  };
}

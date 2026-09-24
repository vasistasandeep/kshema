/**
 * Telemetry & ghost-signal ingestion routes (task 5.1 — R5.1-R5.3, R5.5, R6.2, R6.3).
 *
 * Mounted under `/api/v1`, so effective paths are:
 *   - `POST /api/v1/telemetry/heartbeat`      append a Telemetry_Log row
 *   - `POST /api/v1/telemetry/ghost-signal`   append a Ghost_Signal_Log row
 *
 * Both routes require a valid bearer token (`app.authenticate`); the row is
 * always written for the *authenticated* user (`request.user.sub`) — the body
 * carries no `userId`, so a caller can only append telemetry for itself.
 *
 * Privacy by construction (R5.5, R19.1): neither the request DTOs
 * (`HeartbeatSchema` / `GhostSignalSchema` in `@kshema/types`, both `.strict()`)
 * nor the Prisma models (`TelemetryLog` / `GhostSignalLog`) carry a continuous
 * location trace / GPS column. This route adds none — it maps only the passive
 * well-being fields onto the existing columns.
 *
 * After persisting, each route emits a domain event on `app.events` for the
 * Sentinel worker to consume (a heartbeat -> `telemetry.received`, a ghost
 * signal -> `ghost.received`); the worker uses these to satisfy pending
 * Routine_Rhythm checks (R5.6 / R6.4, implemented in the worker task). The
 * response is a small acknowledgement (`TelemetryAckSchema`: `{ id, receivedAt }`).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  BulkSyncResponseSchema,
  BulkSyncSchema,
  GhostSignalSchema,
  HeartbeatSchema,
  TelemetryAckSchema,
  type BulkSyncHeartbeatResult,
} from "@kshema/types";

/** Clock-skew admission window relative to the server `receivedAt` (R24, R4). */
const CLOCK_SKEW_FUTURE_MS = 2 * 60 * 1000; // capturedAt <= receivedAt + 2 minutes
const CLOCK_SKEW_PAST_MS = 7 * 24 * 60 * 60 * 1000; // capturedAt >= receivedAt - 7 days

/**
 * A heartbeat is admitted to the 14-day Bayesian rhythm baseline iff its
 * client-supplied `capturedAt` lies within `[receivedAt - 7d, receivedAt + 2m]`
 * (R24.2, R24.3, R4.1). Outside that window the device clock is mis-set, so the
 * heartbeat is persisted but flagged clock-skew and excluded from the baseline.
 */
function isWithinClockSkewWindow(capturedAt: Date, receivedAt: Date): boolean {
  const captured = capturedAt.getTime();
  return (
    captured <= receivedAt.getTime() + CLOCK_SKEW_FUTURE_MS &&
    captured >= receivedAt.getTime() - CLOCK_SKEW_PAST_MS
  );
}

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /telemetry/heartbeat — record passive well-being signals for the
  // authenticated Anchor in the Telemetry_Log and emit `telemetry.received`
  // (R5.1, R5.2, R5.3, R5.5).
  typed.post(
    "/telemetry/heartbeat",
    {
      onRequest: [app.authenticate],
      schema: {
        body: HeartbeatSchema,
        response: { 200: TelemetryAckSchema },
      },
    },
    async (request) => {
      const userId = request.user.sub;
      const { screenUnlocks, stepDelta, battery, chargerState, capturedAt } =
        request.body;

      // Map the heartbeat onto the Telemetry_Log columns. `screenUnlocks` is a
      // list of unlock timestamps; the log records only whether an unlock
      // occurred in this heartbeat (a confirming passive signal — R5.1). No
      // location field is written or accepted (R5.5).
      const log = await app.prisma.telemetryLog.create({
        data: {
          userId,
          screenUnlock: screenUnlocks.length > 0,
          stepDelta,
          ...(battery !== undefined ? { batteryLevel: battery } : {}),
          ...(chargerState !== undefined ? { chargerState } : {}),
          capturedAt: new Date(capturedAt),
        },
      });

      // Notify the Sentinel worker so a pending Routine_Rhythm check can be
      // satisfied by this passive signal (R5.6, handled in the worker).
      await app.events.emit("telemetry.received", {
        telemetryLogId: log.id,
        userId,
      });

      return { id: log.id, receivedAt: log.receivedAt.toISOString() };
    },
  );

  // POST /telemetry/ghost-signal — record an ambient household Ghost_Signal
  // for the authenticated Anchor and emit `ghost.received` (R6.2, R6.3).
  typed.post(
    "/telemetry/ghost-signal",
    {
      onRequest: [app.authenticate],
      schema: {
        body: GhostSignalSchema,
        response: { 200: TelemetryAckSchema },
      },
    },
    async (request) => {
      const userId = request.user.sub;
      const { signalType, source, detectedAt } = request.body;

      const log = await app.prisma.ghostSignalLog.create({
        data: {
          userId,
          signalType,
          ...(source !== undefined ? { source } : {}),
          detectedAt: new Date(detectedAt),
        },
      });

      // Notify the Sentinel worker so a pending morning Routine_Rhythm check
      // can be marked confirmed by this Ghost_Signal (R6.4, handled in the
      // worker).
      await app.events.emit("ghost.received", {
        ghostSignalLogId: log.id,
        userId,
      });

      return { id: log.id, receivedAt: new Date().toISOString() };
    },
  );

  // POST /telemetry/bulk-sync — reconcile a batch of buffered heartbeats (and
  // ghost signals) flushed from the on-device Offline_Telemetry_Queue on
  // reconnect (R24.1, R24.2, R24.3, R4.1).
  //
  // Idempotency (R24.2): the batch is deduplicated on `(deviceId, capturedAt)`.
  // SCHEMA CONSTRAINT GAP: `TelemetryLog` has no `deviceId` column and no
  // unique constraint on `(userId, capturedAt)` — only `@@index([userId,
  // capturedAt])`. Since every row is written for the authenticated user and
  // the request carries a single `deviceId`, the effective idempotency key
  // reduces to `(userId, capturedAt)`. We therefore dedup in application logic:
  //   (a) collapse duplicate `capturedAt` values *within* the batch, then
  //   (b) skip any `capturedAt` that already has a row for this user.
  // A resend of the same batch thus produces no new rows. (A future migration
  // adding `deviceId` + a `@@unique([userId, deviceId, capturedAt])` would let
  // this move to `createMany({ skipDuplicates: true })`.)
  //
  // Clock-skew guard (R24.3, R4.1): each newly-persisted heartbeat is admitted
  // to the rhythm baseline iff `capturedAt` is within
  // `[receivedAt - 7d, receivedAt + 2m]` (receivedAt = server now). Out-of-
  // window heartbeats are still persisted but flagged clock-skew and excluded
  // from the baseline. Because `TelemetryLog` has no clock-skew flag column,
  // the admit/exclude decision is surfaced per-heartbeat in the RESPONSE
  // (`results[]`) and enforced by emitting `telemetry.received` (the signal the
  // worker's baseline consumes) ONLY for admitted heartbeats.
  typed.post(
    "/telemetry/bulk-sync",
    {
      onRequest: [app.authenticate],
      schema: {
        body: BulkSyncSchema,
        response: { 200: BulkSyncResponseSchema },
      },
    },
    async (request) => {
      const userId = request.user.sub;
      const { heartbeats, ghostSignals } = request.body;
      const receivedAt = new Date();

      // (a) Collapse duplicate capturedAt values within this batch, keeping the
      // first occurrence. Order is preserved so `results[]` mirrors the request.
      const seenInBatch = new Set<string>();
      const results: BulkSyncHeartbeatResult[] = [];

      interface Pending {
        resultIndex: number;
        capturedAtIso: string;
        capturedAt: Date;
        admitted: boolean;
        screenUnlock: boolean;
        stepDelta: number;
        batteryLevel?: number;
        chargerState?: string;
      }
      const pending: Pending[] = [];

      for (const hb of heartbeats) {
        const capturedAt = new Date(hb.capturedAt);
        const capturedAtIso = capturedAt.toISOString();
        const resultIndex = results.length;

        if (seenInBatch.has(capturedAtIso)) {
          results.push({ capturedAt: capturedAtIso, status: "duplicate" });
          continue;
        }
        seenInBatch.add(capturedAtIso);

        const admitted = isWithinClockSkewWindow(capturedAt, receivedAt);
        // Placeholder result; status/id finalized after DB dedup + insert.
        results.push({ capturedAt: capturedAtIso, status: "duplicate" });
        pending.push({
          resultIndex,
          capturedAtIso,
          capturedAt,
          admitted,
          screenUnlock: hb.screenUnlocks.length > 0,
          stepDelta: hb.stepDelta,
          ...(hb.battery !== undefined ? { batteryLevel: hb.battery } : {}),
          ...(hb.chargerState !== undefined
            ? { chargerState: hb.chargerState }
            : {}),
        });
      }

      // (b) Skip capturedAt values already persisted for this user (idempotent
      // resend). Query only the candidate timestamps in this batch.
      let existing = new Set<string>();
      if (pending.length > 0) {
        const rows = await app.prisma.telemetryLog.findMany({
          where: {
            userId,
            capturedAt: { in: pending.map((p) => p.capturedAt) },
          },
          select: { capturedAt: true },
        });
        existing = new Set(rows.map((r) => r.capturedAt.toISOString()));
      }

      const toInsert = pending.filter((p) => !existing.has(p.capturedAtIso));

      // Persist all novel heartbeats (both admitted and clock-skew-flagged —
      // out-of-window rows are still stored, just excluded from the baseline).
      // Insert one row at a time so we can capture ids for the response and emit
      // `telemetry.received` only for admitted rows.
      let accepted = 0;
      let clockSkewFlagged = 0;
      for (const p of toInsert) {
        const row = await app.prisma.telemetryLog.create({
          data: {
            userId,
            screenUnlock: p.screenUnlock,
            stepDelta: p.stepDelta,
            ...(p.batteryLevel !== undefined
              ? { batteryLevel: p.batteryLevel }
              : {}),
            ...(p.chargerState !== undefined
              ? { chargerState: p.chargerState }
              : {}),
            capturedAt: p.capturedAt,
          },
        });

        if (p.admitted) {
          accepted += 1;
          results[p.resultIndex] = {
            capturedAt: p.capturedAtIso,
            status: "admitted",
            id: row.id,
          };
          // Only admitted heartbeats feed the worker's 14-day baseline (R4.1).
          await app.events.emit("telemetry.received", {
            telemetryLogId: row.id,
            userId,
          });
        } else {
          clockSkewFlagged += 1;
          results[p.resultIndex] = {
            capturedAt: p.capturedAtIso,
            status: "clock_skew",
            id: row.id,
          };
        }
      }

      const duplicates = results.filter((r) => r.status === "duplicate").length;

      // Idempotent bulk insert for ghost signals too: skip any (userId,
      // signalType, detectedAt) already stored, then create the rest and emit
      // `ghost.received` for each new one.
      if (ghostSignals.length > 0) {
        for (const gs of ghostSignals) {
          const detectedAt = new Date(gs.detectedAt);
          const already = await app.prisma.ghostSignalLog.findFirst({
            where: { userId, signalType: gs.signalType, detectedAt },
            select: { id: true },
          });
          if (already) continue;
          const log = await app.prisma.ghostSignalLog.create({
            data: {
              userId,
              signalType: gs.signalType,
              ...(gs.source !== undefined ? { source: gs.source } : {}),
              detectedAt,
            },
          });
          await app.events.emit("ghost.received", {
            ghostSignalLogId: log.id,
            userId,
          });
        }
      }

      // Update the last successful telemetry sync time so the worker uses it
      // instead of wall-clock silence when evaluating routine confirmation
      // (R24.3). No unique-on-userId / deviceId constraint exists, so update
      // every DeviceConfig row for this user (typically one).
      await app.prisma.deviceConfig.updateMany({
        where: { userId },
        data: { lastTelemetrySyncAt: receivedAt },
      });

      return {
        accepted,
        duplicates,
        clockSkewFlagged,
        lastTelemetrySyncAt: receivedAt.toISOString(),
        results,
      };
    },
  );
}

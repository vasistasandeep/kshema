/**
 * @kshema/types — telemetry & ghost-signal DTOs (R5, R6, R24).
 *
 * No telemetry DTO carries a continuous location trace / GPS coordinate by
 * construction (R5.5, R19.1). `.strict()` rejects any unexpected location
 * field.
 */
import { z } from "zod";
import { ChargerStateSchema, GhostSignalTypeSchema } from "./enums.js";
import { Id, IsoDateTime, NonEmptyString } from "./common.js";

export const HeartbeatSchema = z
  .object({
    deviceId: NonEmptyString,
    screenUnlocks: z.array(IsoDateTime).default([]),
    stepDelta: z.number().int().min(0).default(0),
    battery: z.number().int().min(0).max(100).optional(),
    chargerState: ChargerStateSchema.optional(),
    capturedAt: IsoDateTime,
  })
  .strict();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const GhostSignalSchema = z
  .object({
    signalType: GhostSignalTypeSchema,
    source: NonEmptyString.optional(),
    detectedAt: IsoDateTime,
  })
  .strict();
export type GhostSignal = z.infer<typeof GhostSignalSchema>;

export const BulkSyncSchema = z
  .object({
    deviceId: NonEmptyString,
    heartbeats: z.array(HeartbeatSchema).default([]),
    ghostSignals: z.array(GhostSignalSchema).default([]),
    lastSyncAt: IsoDateTime.optional(),
  })
  .strict();
export type BulkSync = z.infer<typeof BulkSyncSchema>;

/**
 * Per-heartbeat reconciliation outcome for a bulk-sync (R24.2, R24.3, R4.1).
 *
 * Because the `TelemetryLog` model carries no clock-skew flag column, the
 * admit/exclude decision is surfaced here in the RESPONSE per buffered
 * heartbeat rather than persisted:
 *   - `status: "admitted"`   — persisted AND admitted to the rhythm baseline
 *                              (in the clock-skew window; `telemetry.received`
 *                              was emitted for it).
 *   - `status: "duplicate"`  — a prior row already existed for
 *                              `(deviceId, capturedAt)`; skipped, no new row.
 *   - `status: "clock_skew"` — persisted but flagged with a clock-skew warning
 *                              and EXCLUDED from the rhythm baseline (its
 *                              `capturedAt` fell outside
 *                              `[receivedAt - 7d, receivedAt + 2m]`).
 */
export const BulkSyncHeartbeatResultSchema = z
  .object({
    capturedAt: IsoDateTime,
    status: z.enum(["admitted", "duplicate", "clock_skew"]),
    /** Present (id of the persisted row) for `admitted` and `clock_skew`. */
    id: Id.optional(),
  })
  .strict();
export type BulkSyncHeartbeatResult = z.infer<
  typeof BulkSyncHeartbeatResultSchema
>;

export const BulkSyncResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
    duplicates: z.number().int().min(0),
    clockSkewFlagged: z.number().int().min(0),
    lastTelemetrySyncAt: IsoDateTime,
    /** Per-buffered-heartbeat outcome, in request order. */
    results: z.array(BulkSyncHeartbeatResultSchema).default([]),
  })
  .strict();
export type BulkSyncResponse = z.infer<typeof BulkSyncResponseSchema>;

export const TelemetryAckSchema = z
  .object({
    id: Id,
    receivedAt: IsoDateTime,
  })
  .strict();
export type TelemetryAck = z.infer<typeof TelemetryAckSchema>;

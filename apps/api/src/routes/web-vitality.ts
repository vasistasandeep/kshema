/**
 * Web Observer vitality history (task 20.2 — R28.13, R28.14, R28.15).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `GET /api/v1/web/vitality/rhythm?days=30&anchorId=`   connection-rhythm calendar
 *   - `GET /api/v1/web/vitality/voice-notes?anchorId=`      archived ≤10s replies + Pulse cards
 *
 * Both require a valid web session (`app.authenticate`).
 *
 * ---------------------------------------------------------------------------
 * NO LOCATION BREADCRUMB (R28.15). Neither view selects or emits any location
 * field; the `VitalityRhythmResponse` / `VoiceNoteArchiveResponse` DTOs
 * additionally forbid one structurally (`.strict()`).
 *
 * AUTHORIZATION. The caller must OBSERVE the requested `anchorId` — i.e. share
 * a Circle with the Anchor while holding an Observer-side role (OBSERVER or
 * MUTUAL) — otherwise `403`. An Anchor viewing their own history (Mutual /
 * self) is permitted. When `anchorId` is omitted the caller's first observed
 * Anchor is used, so the single-Anchor common case needs no parameter.
 *
 * RHYTHM (`/web/vitality/rhythm`, R28.13). A dense per-day series over the
 * requested window (default 30 days) of: the morning confirmation time
 * (newest `VitalityPulseLog.confirmedAt` that day), the Sparsh interaction
 * count involving the Anchor, and the day's step progression (summed positive
 * `TelemetryLog.stepDelta`). Days with no activity are zero-filled so the
 * calendar renders contiguously.
 *
 * VOICE NOTES (`/web/vitality/voice-notes`, R28.14). Archived micro-voice
 * replies (≤10s) plus `Vitality_Pulse` cards for playback. There is no
 * persisted voice-note model yet, so the audio archive is sourced behind an
 * injectable `VoiceNoteArchiveSource` seam (default: empty). The
 * `Vitality_Pulse` cards are read from `VitalityPulseLog` directly, so the
 * Pulse-card half of the archive is fully functional today; the audio-clip
 * half lights up once the storage task lands the object store + model.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  VitalityRhythmQuerySchema,
  VitalityRhythmResponseSchema,
  VoiceNoteArchiveResponseSchema,
  type VitalityRhythmDay,
  type VoiceNoteArchiveEntry,
} from "@kshema/types";

/** Circle roles that make the CALLER an Observer of the Circle's Anchors. */
const OBSERVER_ROLES = ["OBSERVER", "MUTUAL"] as const;

const ForbiddenSchema = z
  .object({ error: z.literal("Forbidden"), message: z.string().min(1) })
  .strict();

/** Query for both endpoints: window size (rhythm) + optional target Anchor. */
const RhythmQuerySchema = VitalityRhythmQuerySchema.extend({
  anchorId: z.string().trim().min(1).optional(),
}).strict();

const VoiceNotesQuerySchema = z
  .object({
    anchorId: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Seam: archived micro-voice-note source (R28.14). No persisted voice-note
 * model exists yet (the storage/object-store task lands it later), so the
 * default returns no audio clips and the archive surfaces `Vitality_Pulse`
 * cards only. A production implementation reads clip metadata from the object
 * store keyed by `anchorId`.
 */
export interface VoiceNoteArchiveSource {
  list(input: { anchorId: string }): Promise<VoiceNoteArchiveEntry[]>;
}

/** Default source: no archived audio clips yet. */
export class EmptyVoiceNoteArchiveSource implements VoiceNoteArchiveSource {
  async list(): Promise<VoiceNoteArchiveEntry[]> {
    return [];
  }
}

export interface WebVitalityRouteDeps {
  /** Clock injection for deterministic day-bucketing in tests. */
  now?: () => number;
  /** Archived micro-voice-note source seam (default: empty). */
  voiceNoteArchive?: VoiceNoteArchiveSource;
}

/** Format an epoch-ms instant as a UTC `yyyy-mm-dd` day key. */
function toDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function webVitalityRoutes(
  app: FastifyInstance,
  deps: WebVitalityRouteDeps = {},
): Promise<void> {
  const { now = Date.now, voiceNoteArchive = new EmptyVoiceNoteArchiveSource() } =
    deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Resolve the target Anchor for the caller. When `requested` is given, the
   * caller must observe that Anchor (share a Circle in an Observer-side role,
   * or be the Anchor themselves). When omitted, the caller's first observed
   * Anchor is chosen. Returns `undefined` when the caller observes no Anchor
   * or is not authorized for the requested one.
   */
  async function resolveObservableAnchor(
    observerId: string,
    requested: string | undefined,
  ): Promise<string | undefined> {
    const observerMemberships = await app.prisma.circleMember.findMany({
      where: { userId: observerId, role: { in: [...OBSERVER_ROLES] } },
      select: { circleId: true },
    });
    const circleIds = observerMemberships.map((m) => m.circleId);

    // Self-view: an Anchor may always view their own history.
    if (requested && requested === observerId) return requested;

    if (circleIds.length === 0) return undefined;

    const anchorMembers = await app.prisma.circleMember.findMany({
      where: {
        circleId: { in: circleIds },
        role: { in: ["ANCHOR", "MUTUAL"] },
        userId: { not: observerId },
      },
      select: { userId: true },
    });
    const observable = new Set(anchorMembers.map((m) => m.userId));

    if (requested) {
      return observable.has(requested) ? requested : undefined;
    }
    // No explicit target: pick the first observed Anchor deterministically.
    const [first] = [...observable].sort();
    return first;
  }

  // -------------------------------------------------------------------------
  // GET /web/vitality/rhythm — 30-day connection-rhythm calendar (R28.13).
  // -------------------------------------------------------------------------
  typed.get(
    "/web/vitality/rhythm",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: RhythmQuerySchema,
        response: {
          200: VitalityRhythmResponseSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const observerId = request.user.sub;
      const { days, anchorId: requested } = request.query;

      const anchorId = await resolveObservableAnchor(observerId, requested);
      if (!anchorId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "You do not observe this Anchor.",
        });
      }

      const nowMs = now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const startKey = toDayKey(nowMs - (days - 1) * DAY_MS);
      const windowStart = new Date(`${startKey}T00:00:00.000Z`);

      const [pulses, sparsh, telemetry] = await Promise.all([
        app.prisma.vitalityPulseLog.findMany({
          where: { anchorId, confirmedAt: { gte: windowStart } },
          select: { confirmedAt: true },
        }),
        app.prisma.sparshInteraction.findMany({
          where: {
            createdAt: { gte: windowStart },
            OR: [{ fromUserId: anchorId }, { toUserId: anchorId }],
          },
          select: { createdAt: true },
        }),
        app.prisma.telemetryLog.findMany({
          where: {
            userId: anchorId,
            receivedAt: { gte: windowStart },
            stepDelta: { gt: 0 },
          },
          select: { receivedAt: true, stepDelta: true },
        }),
      ]);

      // Bucket per day key.
      const morningByDay = new Map<string, Date>();
      for (const p of pulses) {
        const key = toDayKey(new Date(p.confirmedAt).getTime());
        const cur = morningByDay.get(key);
        // Keep the EARLIEST confirmation of the day — the "morning" one.
        if (!cur || p.confirmedAt.getTime() < cur.getTime()) {
          morningByDay.set(key, p.confirmedAt);
        }
      }

      const sparshByDay = new Map<string, number>();
      for (const s of sparsh) {
        const key = toDayKey(new Date(s.createdAt).getTime());
        sparshByDay.set(key, (sparshByDay.get(key) ?? 0) + 1);
      }

      const stepsByDay = new Map<string, number>();
      for (const t of telemetry) {
        const key = toDayKey(new Date(t.receivedAt).getTime());
        stepsByDay.set(key, (stepsByDay.get(key) ?? 0) + t.stepDelta);
      }

      // Dense, zero-filled series across the window (oldest → newest).
      const series: VitalityRhythmDay[] = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const key = toDayKey(nowMs - i * DAY_MS);
        const morning = morningByDay.get(key);
        const steps = stepsByDay.get(key);
        series.push({
          date: key,
          ...(morning ? { morningConfirmationAt: morning.toISOString() } : {}),
          sparshCount: sparshByDay.get(key) ?? 0,
          ...(steps !== undefined ? { stepProgression: steps } : {}),
        });
      }

      return { days, anchorId, series };
    },
  );

  // -------------------------------------------------------------------------
  // GET /web/vitality/voice-notes — archived ≤10s replies + Pulse cards (R28.14).
  // -------------------------------------------------------------------------
  typed.get(
    "/web/vitality/voice-notes",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: VoiceNotesQuerySchema,
        response: {
          200: VoiceNoteArchiveResponseSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const observerId = request.user.sub;
      const anchorId = await resolveObservableAnchor(
        observerId,
        request.query.anchorId,
      );
      if (!anchorId) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message: "You do not observe this Anchor.",
        });
      }

      const anchor = await app.prisma.user.findUnique({
        where: { id: anchorId },
        select: { preferredName: true },
      });
      const preferredName =
        anchor?.preferredName && anchor.preferredName.trim().length > 0
          ? anchor.preferredName
          : "Anchor";

      // Vitality_Pulse cards (fully functional today).
      const pulses = await app.prisma.vitalityPulseLog.findMany({
        where: { anchorId },
        orderBy: { confirmedAt: "desc" },
        select: { id: true, confirmedAt: true },
      });
      const pulseEntries: VoiceNoteArchiveEntry[] = pulses.map((p) => ({
        id: p.id,
        anchorId,
        kind: "VITALITY_PULSE" as const,
        recordedAt: p.confirmedAt.toISOString(),
        preferredName,
      }));

      // Archived audio clips (seam; empty until the storage task lands).
      const audioEntries = await voiceNoteArchive.list({ anchorId });

      // Newest-first across both kinds.
      const entries = [...audioEntries, ...pulseEntries].sort(
        (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt),
      );

      return { entries };
    },
  );
}

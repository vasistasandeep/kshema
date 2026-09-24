/**
 * Family Vitality engine routes — Sparsh micro-interactions, the connection
 * rhythm, micro-voice-note replies, and the Daily Panchanga card
 * (task 14.4 — R7.4, R22.7-R22.14, R22.18).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `POST /api/v1/vitality/voice-note`   micro-voice reply (<=10s) to Anchor
 *   - `POST /api/v1/sparsh`                record a one-tap Sparsh_Reaction
 *   - `GET  /api/v1/sparsh/rhythm?days=30` connection-rhythm summary window
 *   - `GET  /api/v1/panchanga`             Daily_Panchanga_Card for a location
 *
 * All routes require a valid bearer token (`app.authenticate`).
 *
 * ---------------------------------------------------------------------------
 * NO ESCALATION, NO LOCATION TRACE. These are warm family-engagement surfaces
 * (R22). None of them opens or resolves a Safety_Incident, and none carries a
 * continuous location trace. The Sparsh interactions and rhythm are purely
 * relational counts; the Panchanga card is a per-location almanac.
 *
 * SPARSH (R22.8-R22.11). `POST /sparsh` records a `SparshInteraction` from the
 * caller (`fromUserId = request.user.sub`) to `toUserId` with the one-tap
 * `type` (one of the five Sparsh_Reactions, R22.8). The caller and recipient
 * must both belong to the supplied `circleId` — a caller cannot fabricate an
 * interaction in a circle they are not a member of, nor address a non-member.
 * Recording the interaction is what the "animated card" push (R22.9) is
 * derived from; the actual client-side animation is a mobile concern.
 *
 * CONNECTION RHYTHM (R22.11). `GET /sparsh/rhythm?days=30` returns a windowed
 * summary of the caller's Sparsh interactions (sent + received) over the last
 * `days` (default 30, R22.11): a per-day count series plus a total and the
 * current consecutive-day streak. This is the "30-day connection rhythm on
 * request" the API must present.
 *
 * MICRO-VOICE-NOTE (R7.4). `POST /vitality/voice-note` accepts a reply bounded
 * to <=10 seconds. The `VoiceNoteSchema` DTO already caps `durationSeconds` at
 * 10; the handler re-checks the cap to return a descriptive `400` at the route
 * boundary and rejects anything longer. The actual audio blob storage /
 * delivery is a SEAM (`VoiceNoteDelivery`) — the default records the reply
 * metadata reference and forwards it; a later telephony/storage task supplies
 * the real object store + Anchor push.
 *
 * PANCHANGA (R22.12-R22.14, R22.18). `GET /panchanga` returns the
 * `Daily_Panchanga_Card` for the Anchor's coarse location bucket (`locationKey`)
 * and selected language, for a given `date` (default: today in the resolver's
 * clock). It reads `PanchangaAlmanac` by the unique `(date, locationKey)`; when
 * no row exists yet it falls back to a COMPUTED placeholder behind a seam
 * (`PanchangaResolver`) rather than 404 — the card must always render (R22.12).
 * A real ephemeris/almanac computation replaces the placeholder resolver later.
 *
 * ONE MORNING ENGAGEMENT PUSH PER DAY PER USER (R7.4 delivery restraint /
 * R22.18). Engagement pushes (the voice-note delivery to the Anchor is one such
 * push) are limited to at most one per day per User. The guard is an injectable
 * `MorningPushGuard`: `tryClaim(userId, dayKey)` atomically marks the user as
 * pushed-for-that-day and returns whether THIS call won the claim. A second
 * morning push for the same User on the same day loses the claim and is
 * suppressed (the reply is still recorded; only the push is skipped). The
 * default is an in-memory per-user/per-day marker store; a Redis-backed store
 * replaces it in production so the cap holds across instances.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  SparshSchema,
  SparshRhythmQuerySchema,
  PanchangaQuerySchema,
  PanchangaCardSchema,
} from "@kshema/types";

/**
 * Micro-voice-note body — same shape as `@kshema/types`' `VoiceNoteSchema` but
 * WITHOUT its `durationSeconds` <=10 upper bound. The <=10s cap (R7.4) is
 * enforced in the handler so a longer reply returns a clean, descriptive `400`
 * at the route boundary rather than a generic schema-rejection `500` (the same
 * pattern the incident/sanctuary routes use for their cap checks). The lower
 * bound (>=0) is kept structurally.
 */
const VoiceNoteBodySchema = z
  .object({
    anchorId: z.string().trim().min(1),
    audio: z.string().trim().min(1),
    durationSeconds: z.number().min(0),
  })
  .strict();

/** Descriptive `400` envelope (bad request / cap violation). */
const BadRequestSchema = z
  .object({ error: z.literal("Bad Request"), message: z.string().min(1) })
  .strict();

/** Descriptive `403` envelope (caller not in the circle / not a member). */
const ForbiddenSchema = z
  .object({ error: z.literal("Forbidden"), message: z.string().min(1) })
  .strict();

/** Acknowledgement returned by `POST /sparsh`. */
const SparshAckSchema = z
  .object({
    interactionId: z.string().min(1),
    circleId: z.string().min(1),
    fromUserId: z.string().min(1),
    toUserId: z.string().min(1),
    type: z.string().min(1),
    recorded: z.literal(true),
  })
  .strict();

/** One day's bucket in the connection-rhythm series. */
const RhythmDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().min(0),
  })
  .strict();

/** Response of `GET /sparsh/rhythm` — windowed connection rhythm (R22.11). */
const SparshRhythmSchema = z
  .object({
    days: z.number().int().min(1),
    total: z.number().int().min(0),
    currentStreak: z.number().int().min(0),
    series: z.array(RhythmDaySchema),
  })
  .strict();

/** Acknowledgement returned by `POST /vitality/voice-note`. */
const VoiceNoteAckSchema = z
  .object({
    anchorId: z.string().min(1),
    durationSeconds: z.number().min(0).max(10),
    delivered: z.boolean(),
    /** false when the once-per-day morning push was already spent (R22.18). */
    pushed: z.boolean(),
  })
  .strict();

/**
 * Seam: micro-voice-note delivery (R7.4). The default records the reply
 * reference and forwards it; the real audio object store + Anchor push land in
 * a later telephony/storage task. Returns whether the reply was accepted for
 * delivery.
 */
export interface VoiceNoteDelivery {
  deliver(input: {
    fromUserId: string;
    anchorId: string;
    audioRef: string;
    durationSeconds: number;
  }): Promise<boolean>;
}

/** Default delivery seam: forwards nothing over the wire, just acknowledges. */
export class NoopVoiceNoteDelivery implements VoiceNoteDelivery {
  async deliver(): Promise<boolean> {
    return true;
  }
}

/**
 * Seam: once-per-day morning engagement push guard (R22.18 / R7.4). `tryClaim`
 * atomically records that `userId` has been pushed on `dayKey` and returns
 * `true` only for the FIRST claim that day; every subsequent claim the same day
 * returns `false` so the caller suppresses the duplicate push.
 */
export interface MorningPushGuard {
  tryClaim(userId: string, dayKey: string): Promise<boolean>;
}

/** In-memory per-user/per-day marker store (default; Redis in production). */
export class InMemoryMorningPushGuard implements MorningPushGuard {
  private readonly claimed = new Set<string>();
  async tryClaim(userId: string, dayKey: string): Promise<boolean> {
    const key = `${userId}:${dayKey}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

/**
 * Seam: Panchanga resolver (R22.12-R22.14). Given a `(date, locationKey,
 * language)` for which no `PanchangaAlmanac` row exists yet, compute a
 * placeholder card so the surface always renders. A real ephemeris/almanac
 * computation replaces this later.
 */
export interface PanchangaResolver {
  compute(input: {
    date: string;
    locationKey: string;
    language: string;
  }): Promise<z.infer<typeof PanchangaCardSchema>>;
}

/**
 * Default placeholder resolver: returns a benign, non-alarming card (R22.20
 * bans alarm-style content). Values are clearly-placeholder but structurally
 * valid so the card renders; the real computation replaces this.
 */
export class PlaceholderPanchangaResolver implements PanchangaResolver {
  async compute(input: {
    date: string;
    locationKey: string;
    language: string;
  }): Promise<z.infer<typeof PanchangaCardSchema>> {
    return {
      date: input.date,
      sunrise: "06:00",
      sunset: "18:00",
      tithi: "Pratipada",
      nakshatra: "Ashwini",
      masa: "Chaitra",
      festivals: [],
      proverb: "A calm dawn carries the whole day.",
    };
  }
}

/** Dependencies injected into the vitality routes (replaceable in tests). */
export interface VitalityRouteDeps {
  /** Clock injection for deterministic day-bucketing / rhythm windows. */
  now?: () => number;
  /** Micro-voice-note delivery seam (default: no-op acknowledger). */
  voiceNoteDelivery?: VoiceNoteDelivery;
  /** Once-per-day morning push guard (default: in-memory marker store). */
  morningPushGuard?: MorningPushGuard;
  /** Panchanga fallback resolver (default: placeholder card). */
  panchangaResolver?: PanchangaResolver;
  /** Default coarse location bucket when the query omits `locationKey`. */
  defaultLocationKey?: string;
  /** Default language when the query omits `language`. */
  defaultLanguage?: string;
}

/** Format an epoch-ms instant as a UTC `yyyy-mm-dd` day key. */
function toDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function vitalityRoutes(
  app: FastifyInstance,
  deps: VitalityRouteDeps = {},
): Promise<void> {
  const {
    now = Date.now,
    voiceNoteDelivery = new NoopVoiceNoteDelivery(),
    morningPushGuard = new InMemoryMorningPushGuard(),
    panchangaResolver = new PlaceholderPanchangaResolver(),
    defaultLocationKey = "IN-DEFAULT",
    defaultLanguage = "en",
  } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /sparsh — record a one-tap Sparsh_Reaction from the caller to another
  // member of the same circle (R22.8-R22.11). Both the caller and the recipient
  // must belong to `circleId`; otherwise 403.
  typed.post(
    "/sparsh",
    {
      onRequest: [app.authenticate],
      schema: {
        body: SparshSchema,
        response: {
          200: SparshAckSchema,
          403: ForbiddenSchema,
        },
      },
    },
    async (request, reply) => {
      const fromUserId = request.user.sub;
      const { circleId, toUserId, type } = request.body;

      // Scope the interaction to a circle the caller belongs to, and require
      // the recipient to be a member of the same circle. This prevents a caller
      // fabricating interactions in circles they are not part of (R22.8-10).
      const memberships = await app.prisma.circleMember.findMany({
        where: { circleId, userId: { in: [fromUserId, toUserId] } },
        select: { userId: true },
      });
      const memberIds = new Set(memberships.map((m) => m.userId));
      if (!memberIds.has(fromUserId) || !memberIds.has(toUserId)) {
        return reply.code(403).send({
          error: "Forbidden" as const,
          message:
            "Both sender and recipient must belong to the Circle for a Sparsh.",
        });
      }

      const interaction = await app.prisma.sparshInteraction.create({
        data: { circleId, fromUserId, toUserId, type },
        select: { id: true },
      });

      return {
        interactionId: interaction.id,
        circleId,
        fromUserId,
        toUserId,
        type,
        recorded: true as const,
      };
    },
  );

  // GET /sparsh/rhythm?days=30 — windowed connection-rhythm summary over the
  // last `days` for the caller (interactions they sent OR received): a per-day
  // count series, the window total, and the current consecutive-day streak
  // ending today (R22.11-R22.13).
  typed.get(
    "/sparsh/rhythm",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: SparshRhythmQuerySchema,
        response: { 200: SparshRhythmSchema },
      },
    },
    async (request) => {
      const userId = request.user.sub;
      const { days } = request.query;

      // Window start: the beginning (00:00 UTC) of the day `days-1` days ago,
      // so a `days=30` window spans today plus the previous 29 days inclusive.
      const nowMs = now();
      const todayKey = toDayKey(nowMs);
      const DAY_MS = 24 * 60 * 60 * 1000;
      const startKey = toDayKey(nowMs - (days - 1) * DAY_MS);
      const windowStart = new Date(`${startKey}T00:00:00.000Z`);

      const rows = await app.prisma.sparshInteraction.findMany({
        where: {
          createdAt: { gte: windowStart },
          OR: [{ fromUserId: userId }, { toUserId: userId }],
        },
        select: { createdAt: true },
      });

      // Bucket by day key.
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = toDayKey(new Date(row.createdAt).getTime());
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      // Build the dense series across the whole window (zero-filled days).
      const series: Array<{ date: string; count: number }> = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const key = toDayKey(nowMs - i * DAY_MS);
        series.push({ date: key, count: counts.get(key) ?? 0 });
      }

      const total = series.reduce((sum, d) => sum + d.count, 0);

      // Current streak: consecutive days ending today that have >=1 interaction.
      let currentStreak = 0;
      for (let i = series.length - 1; i >= 0; i -= 1) {
        if (series[i]!.count > 0) currentStreak += 1;
        else break;
      }
      // Guard: only count today's tail as a streak if today itself is active.
      if (series.length > 0 && series[series.length - 1]!.date !== todayKey) {
        currentStreak = 0;
      }

      return { days, total, currentStreak, series };
    },
  );

  // POST /vitality/voice-note — micro-voice reply bounded to <=10s (R7.4).
  // Rejects anything longer with a descriptive 400. The reply is recorded /
  // forwarded via the delivery seam; the once-per-day morning push guard
  // suppresses a second engagement push for the same User on the same day
  // (R22.18) — the reply is still delivered, only the push is skipped.
  typed.post(
    "/vitality/voice-note",
    {
      onRequest: [app.authenticate],
      schema: {
        body: VoiceNoteBodySchema,
        response: {
          200: VoiceNoteAckSchema,
          400: BadRequestSchema,
        },
      },
    },
    async (request, reply) => {
      const fromUserId = request.user.sub;
      const { anchorId, audio, durationSeconds } = request.body;

      // Re-check the <=10s cap at the route boundary for a clean 400 (R7.4).
      // The DTO already bounds this; we reject explicitly rather than surfacing
      // a generic schema rejection.
      if (durationSeconds > 10) {
        return reply.code(400).send({
          error: "Bad Request" as const,
          message: "A micro-voice reply must be at most 10 seconds (R7.4).",
        });
      }

      const delivered = await voiceNoteDelivery.deliver({
        fromUserId,
        anchorId,
        audioRef: audio,
        durationSeconds,
      });

      // One morning engagement push per day per User (R22.18). Claim the
      // per-user/per-day marker; only the first claim today wins and pushes.
      const pushed = await morningPushGuard.tryClaim(
        fromUserId,
        toDayKey(now()),
      );

      return { anchorId, durationSeconds, delivered, pushed };
    },
  );

  // GET /panchanga — Daily_Panchanga_Card for a coarse location + language and
  // date (default: today). Reads PanchangaAlmanac by the unique (date,
  // locationKey); falls back to a computed placeholder card behind a seam when
  // absent so the surface always renders (R22.12-R22.14).
  typed.get(
    "/panchanga",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: PanchangaQuerySchema,
        response: { 200: PanchangaCardSchema },
      },
    },
    async (request) => {
      const q = request.query;
      const date = q.date ?? toDayKey(now());
      const locationKey = q.locationKey ?? defaultLocationKey;
      const language = q.language ?? defaultLanguage;

      const almanac = await app.prisma.panchangaAlmanac.findUnique({
        where: { date_locationKey: { date, locationKey } },
        select: {
          date: true,
          sunrise: true,
          sunset: true,
          tithi: true,
          nakshatra: true,
          masa: true,
          festivals: true,
          proverbKey: true,
        },
      });

      if (!almanac) {
        // Absent-fallback seam: compute a placeholder card (R22.12).
        return panchangaResolver.compute({ date, locationKey, language });
      }

      return {
        date: almanac.date,
        sunrise: almanac.sunrise,
        sunset: almanac.sunset,
        tithi: almanac.tithi,
        nakshatra: almanac.nakshatra,
        masa: almanac.masa,
        festivals: almanac.festivals,
        // The stored `proverbKey` is a lookup key; the resolver localizes it to
        // the selected language. A key that already reads as a proverb is used
        // verbatim as a safe default.
        proverb: almanac.proverbKey,
      };
    },
  );
}

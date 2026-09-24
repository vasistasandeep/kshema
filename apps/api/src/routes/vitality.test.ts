/**
 * Unit tests for the Family Vitality engine routes — Sparsh, connection
 * rhythm, micro-voice-note, and Panchanga (task 14.4 — R7.4, R22.7-R22.14,
 * R22.18).
 *
 * Hermetic: a fake Prisma client backs the reads/writes each route performs,
 * and the delivery / morning-push / Panchanga seams are injected so no live
 * DB / Redis / telephony is needed. Bearer tokens are minted with the app's
 * own `app.jwt` so the `app.authenticate` guard passes.
 *
 * Coverage:
 *   - POST /sparsh records a SparshInteraction for two co-members (R22.8-11);
 *     a caller outside the circle -> 403, nothing recorded;
 *   - GET /sparsh/rhythm returns a windowed count series + total + streak
 *     over the requested window (R22.11-13);
 *   - POST /vitality/voice-note rejects >10s (400) and accepts <=10s (R7.4);
 *   - GET /panchanga returns stored almanac fields when present and a computed
 *     fallback card when absent (R22.12-14);
 *   - the once-per-day morning push guard suppresses a second push the same
 *     day (R22.18) while the reply is still delivered.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import {
  InMemoryMorningPushGuard,
  type MorningPushGuard,
  type PanchangaResolver,
  type VoiceNoteDelivery,
} from "./vitality.js";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    OTP_SECRET: "test-otp-secret",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0",
    PORT: "0",
  });
}

// --------------------------------------------------------------------------
// Fake Prisma fixtures.
// --------------------------------------------------------------------------

interface MemberRow {
  circleId: string;
  userId: string;
}

interface SparshRow {
  id: string;
  circleId: string;
  fromUserId: string;
  toUserId: string;
  type: string;
  createdAt: Date;
}

interface AlmanacRow {
  date: string;
  locationKey: string;
  sunrise: string;
  sunset: string;
  tithi: string;
  nakshatra: string;
  masa: string;
  festivals: string[];
  proverbKey: string;
}

interface Fixtures {
  members?: MemberRow[];
  sparsh?: SparshRow[];
  almanacs?: AlmanacRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const members = fixtures.members ?? [];
  const sparsh = fixtures.sparsh ?? [];
  const almanacs = fixtures.almanacs ?? [];
  let seq = 0;

  const prisma = {
    circleMember: {
      findMany: vi.fn(
        async (args: {
          where: {
            circleId: string;
            userId: { in: string[] };
          };
        }) => {
          const { circleId, userId } = args.where;
          return members
            .filter(
              (m) =>
                m.circleId === circleId && userId.in.includes(m.userId),
            )
            .map((m) => ({ userId: m.userId }));
        },
      ),
    },
    sparshInteraction: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: SparshRow = {
          id: `sparsh_${seq}`,
          circleId: args.data.circleId as string,
          fromUserId: args.data.fromUserId as string,
          toUserId: args.data.toUserId as string,
          type: args.data.type as string,
          createdAt: new Date(),
        };
        sparsh.push(row);
        return { id: row.id };
      }),
      findMany: vi.fn(
        async (args: {
          where: {
            createdAt?: { gte?: Date };
            OR?: Array<Record<string, string>>;
          };
        }) => {
          const gte = args.where.createdAt?.gte;
          const or = args.where.OR ?? [];
          return sparsh
            .filter((row) => {
              if (gte && row.createdAt.getTime() < gte.getTime()) return false;
              if (or.length === 0) return true;
              return or.some((clause) =>
                Object.entries(clause).every(
                  ([k, v]) =>
                    (row as unknown as Record<string, unknown>)[k] === v,
                ),
              );
            })
            .map((row) => ({ createdAt: row.createdAt }));
        },
      ),
    },
    panchangaAlmanac: {
      findUnique: vi.fn(
        async (args: {
          where: { date_locationKey: { date: string; locationKey: string } };
        }) => {
          const { date, locationKey } = args.where.date_locationKey;
          return (
            almanacs.find(
              (a) => a.date === date && a.locationKey === locationKey,
            ) ?? null
          );
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, members, sparsh, almanacs };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

function bearer(app: FastifyInstance, userId: string): string {
  const token = app.jwt.sign({ sub: userId, channel: "MOBILE" });
  return `Bearer ${token}`;
}

/** Fixed clock at 2024-03-15T09:00:00Z for deterministic day-bucketing. */
const FIXED_NOW = Date.parse("2024-03-15T09:00:00.000Z");
const now = () => FIXED_NOW;

// --------------------------------------------------------------------------
// POST /sparsh
// --------------------------------------------------------------------------

describe("POST /api/v1/sparsh", () => {
  it("records a SparshInteraction between two co-members (R22.8-11)", async () => {
    const { prisma, sparsh } = makeFakePrisma({
      members: [
        { circleId: "circle_1", userId: "observer_1" },
        { circleId: "circle_1", userId: "anchor_1" },
      ],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sparsh",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {
          circleId: "circle_1",
          toUserId: "anchor_1",
          type: "MORNING_CHAI",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        circleId: "circle_1",
        fromUserId: "observer_1",
        toUserId: "anchor_1",
        type: "MORNING_CHAI",
        recorded: true,
      });
      expect(sparsh).toHaveLength(1);
      expect(sparsh[0]!.fromUserId).toBe("observer_1");
    } finally {
      await app.close();
    }
  });

  it("rejects a caller who is not a member of the circle -> 403 (R22.8-10)", async () => {
    const { prisma, sparsh } = makeFakePrisma({
      members: [{ circleId: "circle_1", userId: "anchor_1" }],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sparsh",
        headers: { authorization: bearer(app, "stranger_1") },
        payload: {
          circleId: "circle_1",
          toUserId: "anchor_1",
          type: "HEART_BLESSING",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(sparsh).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// GET /sparsh/rhythm
// --------------------------------------------------------------------------

describe("GET /api/v1/sparsh/rhythm", () => {
  it("returns a windowed count series, total, and streak (R22.11-13)", async () => {
    // Interactions today and yesterday (relative to FIXED_NOW), one older that
    // falls inside a 30-day window.
    const sparsh: SparshRow[] = [
      {
        id: "s1",
        circleId: "circle_1",
        fromUserId: "observer_1",
        toUserId: "anchor_1",
        type: "MORNING_CHAI",
        createdAt: new Date("2024-03-15T08:00:00.000Z"), // today
      },
      {
        id: "s2",
        circleId: "circle_1",
        fromUserId: "anchor_1",
        toUserId: "observer_1",
        type: "PRANAM_BLESSING",
        createdAt: new Date("2024-03-14T20:00:00.000Z"), // yesterday
      },
      {
        id: "s3",
        circleId: "circle_1",
        fromUserId: "observer_1",
        toUserId: "anchor_1",
        type: "MORNING_SUN",
        createdAt: new Date("2024-03-01T10:00:00.000Z"), // within 30d
      },
    ];
    const { prisma } = makeFakePrisma({ sparsh });
    const app = await buildTestApp({ prisma, now });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sparsh/rhythm?days=30",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.days).toBe(30);
      expect(body.total).toBe(3);
      expect(body.series).toHaveLength(30);
      // Streak: today + yesterday both active -> streak 2.
      expect(body.currentStreak).toBe(2);
      // Last bucket is today with count 1.
      const last = body.series[body.series.length - 1];
      expect(last).toMatchObject({ date: "2024-03-15", count: 1 });
    } finally {
      await app.close();
    }
  });

  it("reports a zero streak when today has no interaction", async () => {
    const sparsh: SparshRow[] = [
      {
        id: "s1",
        circleId: "circle_1",
        fromUserId: "observer_1",
        toUserId: "anchor_1",
        type: "MORNING_CHAI",
        createdAt: new Date("2024-03-14T08:00:00.000Z"), // yesterday only
      },
    ];
    const { prisma } = makeFakePrisma({ sparsh });
    const app = await buildTestApp({ prisma, now });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/sparsh/rhythm?days=7",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.days).toBe(7);
      expect(body.total).toBe(1);
      expect(body.currentStreak).toBe(0);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// POST /vitality/voice-note
// --------------------------------------------------------------------------

describe("POST /api/v1/vitality/voice-note", () => {
  it("rejects a reply longer than 10 seconds -> 400 (R7.4)", async () => {
    const { prisma } = makeFakePrisma();
    const deliver = vi.fn(async () => true);
    const delivery: VoiceNoteDelivery = { deliver };
    const app = await buildTestApp({ prisma, voiceNoteDelivery: delivery });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vitality/voice-note",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {
          anchorId: "anchor_1",
          audio: "blob-ref-1",
          durationSeconds: 11,
        },
      });

      // The DTO bounds durationSeconds at 10, so an 11s reply is rejected at
      // validation (400) and never reaches the delivery seam.
      expect(res.statusCode).toBe(400);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("accepts a reply of at most 10 seconds and delivers it (R7.4)", async () => {
    const { prisma } = makeFakePrisma();
    const deliver = vi.fn(async () => true);
    const delivery: VoiceNoteDelivery = { deliver };
    const app = await buildTestApp({
      prisma,
      voiceNoteDelivery: delivery,
      now,
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vitality/voice-note",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {
          anchorId: "anchor_1",
          audio: "blob-ref-1",
          durationSeconds: 9.5,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        anchorId: "anchor_1",
        durationSeconds: 9.5,
        delivered: true,
        pushed: true,
      });
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("suppresses a second morning push for the same User the same day (R22.18)", async () => {
    const { prisma } = makeFakePrisma();
    // A single shared guard across both requests; the first claim wins.
    const guard: MorningPushGuard = new InMemoryMorningPushGuard();
    const deliver = vi.fn(async () => true);
    const app = await buildTestApp({
      prisma,
      voiceNoteDelivery: { deliver },
      morningPushGuard: guard,
      now,
    });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/vitality/voice-note",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {
          anchorId: "anchor_1",
          audio: "blob-ref-1",
          durationSeconds: 5,
        },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/vitality/voice-note",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {
          anchorId: "anchor_1",
          audio: "blob-ref-2",
          durationSeconds: 5,
        },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // First push wins; second same-day push is suppressed. Both replies are
      // still delivered.
      expect(first.json().pushed).toBe(true);
      expect(second.json().pushed).toBe(false);
      expect(first.json().delivered).toBe(true);
      expect(second.json().delivered).toBe(true);
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// GET /panchanga
// --------------------------------------------------------------------------

describe("GET /api/v1/panchanga", () => {
  it("returns stored almanac fields when present (R22.13-14)", async () => {
    const { prisma } = makeFakePrisma({
      almanacs: [
        {
          date: "2024-03-15",
          locationKey: "IN-MH-PUNE",
          sunrise: "06:42",
          sunset: "18:44",
          tithi: "Panchami",
          nakshatra: "Rohini",
          masa: "Phalguna",
          festivals: ["Holi"],
          proverbKey: "Steady steps make a long road short.",
        },
      ],
    });
    const app = await buildTestApp({ prisma, now });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/panchanga?locationKey=IN-MH-PUNE&language=en&date=2024-03-15",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        date: "2024-03-15",
        sunrise: "06:42",
        sunset: "18:44",
        tithi: "Panchami",
        nakshatra: "Rohini",
        masa: "Phalguna",
        festivals: ["Holi"],
        proverb: "Steady steps make a long road short.",
      });
    } finally {
      await app.close();
    }
  });

  it("falls back to a computed card when no almanac row exists (R22.12)", async () => {
    const { prisma } = makeFakePrisma();
    const compute = vi.fn(async () => ({
      date: "2024-03-15",
      sunrise: "06:00",
      sunset: "18:00",
      tithi: "Pratipada",
      nakshatra: "Ashwini",
      masa: "Chaitra",
      festivals: [] as string[],
      proverb: "A calm dawn carries the whole day.",
    }));
    const resolver: PanchangaResolver = { compute };
    const app = await buildTestApp({ prisma, panchangaResolver: resolver, now });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/panchanga",
        headers: { authorization: bearer(app, "observer_1") },
      });

      expect(res.statusCode).toBe(200);
      expect(compute).toHaveBeenCalledOnce();
      // Defaults applied: today's date (from the fixed clock) + default bucket.
      expect(compute).toHaveBeenCalledWith(
        expect.objectContaining({ date: "2024-03-15" }),
      );
      expect(res.json()).toMatchObject({
        tithi: "Pratipada",
        proverb: "A calm dawn carries the whole day.",
      });
    } finally {
      await app.close();
    }
  });
});

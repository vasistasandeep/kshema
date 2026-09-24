/**
 * Unit tests for the web Observer vitality history (task 20.2 — R28.13,
 * R28.14, R28.15). Hermetic: a fake Prisma client backs the reads; tokens are
 * minted with `app.jwt`.
 *
 * Coverage:
 *   - rhythm returns a dense, zero-filled per-day series with morning
 *     confirmation, Sparsh count, and step progression (R28.13);
 *   - a caller who does not observe the requested Anchor is 403;
 *   - voice-notes surfaces Vitality_Pulse cards + injected audio clips newest
 *     first (R28.14);
 *   - no location field appears in either response (R28.15);
 *   - both endpoints require authentication.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import {
  type VoiceNoteArchiveSource,
} from "./web-vitality.js";
import type { VoiceNoteArchiveEntry } from "@kshema/types";

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

interface MemberRow {
  circleId: string;
  userId: string;
  role: "ANCHOR" | "OBSERVER" | "MUTUAL";
}
interface PulseRow {
  id: string;
  anchorId: string;
  confirmedAt: Date;
}
interface SparshRow {
  fromUserId: string;
  toUserId: string;
  createdAt: Date;
}
interface TelemetryRow {
  userId: string;
  stepDelta: number;
  receivedAt: Date;
}
interface UserRow {
  id: string;
  preferredName: string | null;
}

interface Fixtures {
  members?: MemberRow[];
  pulses?: PulseRow[];
  sparsh?: SparshRow[];
  telemetry?: TelemetryRow[];
  users?: UserRow[];
}

function within(gte: Date | undefined, at: Date): boolean {
  return !gte || at.getTime() >= gte.getTime();
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const members = fixtures.members ?? [];
  const pulses = fixtures.pulses ?? [];
  const sparsh = fixtures.sparsh ?? [];
  const telemetry = fixtures.telemetry ?? [];
  const users = fixtures.users ?? [];

  const prisma = {
    circleMember: {
      findMany: vi.fn(
        async (args: {
          where: {
            userId?: string | { not?: string };
            circleId?: { in: string[] };
            role?: { in: string[] };
          };
        }) => {
          const where = args.where;
          return members
            .filter((m) => {
              if (typeof where.userId === "string") {
                if (m.userId !== where.userId) return false;
              } else if (where.userId?.not) {
                if (m.userId === where.userId.not) return false;
              }
              if (where.circleId?.in && !where.circleId.in.includes(m.circleId))
                return false;
              if (where.role?.in && !where.role.in.includes(m.role))
                return false;
              return true;
            })
            .map((m) => ({ circleId: m.circleId, userId: m.userId }));
        },
      ),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const u = users.find((r) => r.id === args.where.id);
        return u ? { preferredName: u.preferredName } : null;
      }),
    },
    vitalityPulseLog: {
      // Serves BOTH the rhythm route (where.confirmedAt.gte, select confirmedAt)
      // and the voice-notes route (orderBy desc, select id + confirmedAt). The
      // fake returns id + confirmedAt in either case; the handler selects what
      // it needs, and the response DTO forbids extras.
      findMany: vi.fn(
        async (args: {
          where: { anchorId: string; confirmedAt?: { gte: Date } };
          orderBy?: { confirmedAt: "asc" | "desc" };
        }) => {
          const rows = pulses
            .filter(
              (p) =>
                p.anchorId === args.where.anchorId &&
                within(args.where.confirmedAt?.gte, p.confirmedAt),
            )
            .map((p) => ({ id: p.id, confirmedAt: p.confirmedAt }));
          if (args.orderBy?.confirmedAt === "desc") {
            rows.sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime());
          }
          return rows;
        },
      ),
    },
    sparshInteraction: {
      findMany: vi.fn(
        async (args: {
          where: {
            createdAt?: { gte: Date };
            OR?: Array<{ fromUserId?: string; toUserId?: string }>;
          };
        }) => {
          const or = args.where.OR ?? [];
          const ids = new Set(
            or.flatMap((c) => [c.fromUserId, c.toUserId].filter(Boolean) as string[]),
          );
          return sparsh
            .filter(
              (s) =>
                within(args.where.createdAt?.gte, s.createdAt) &&
                (ids.has(s.fromUserId) || ids.has(s.toUserId)),
            )
            .map((s) => ({ createdAt: s.createdAt }));
        },
      ),
    },
    telemetryLog: {
      findMany: vi.fn(
        async (args: {
          where: {
            userId: string;
            receivedAt?: { gte: Date };
            stepDelta?: { gt: number };
          };
        }) =>
          telemetry
            .filter(
              (t) =>
                t.userId === args.where.userId &&
                within(args.where.receivedAt?.gte, t.receivedAt) &&
                t.stepDelta > (args.where.stepDelta?.gt ?? -1),
            )
            .map((t) => ({ receivedAt: t.receivedAt, stepDelta: t.stepDelta })),
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

function bearer(app: FastifyInstance, userId: string): string {
  return `Bearer ${app.jwt.sign({ sub: userId, channel: "WEB" })}`;
}

const NOW = Date.parse("2024-03-15T12:00:00.000Z");

describe("GET /api/v1/web/vitality/rhythm", () => {
  it("returns a dense zero-filled series with morning, sparsh, and steps (R28.13)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      pulses: [
        { id: "p1", anchorId: "anchor_1", confirmedAt: new Date("2024-03-15T02:30:00.000Z") },
      ],
      sparsh: [
        {
          fromUserId: "observer_1",
          toUserId: "anchor_1",
          createdAt: new Date("2024-03-15T05:00:00.000Z"),
        },
      ],
      telemetry: [
        { userId: "anchor_1", stepDelta: 120, receivedAt: new Date("2024-03-15T06:00:00.000Z") },
        { userId: "anchor_1", stepDelta: 80, receivedAt: new Date("2024-03-15T07:00:00.000Z") },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/vitality/rhythm?days=7&anchorId=anchor_1",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.anchorId).toBe("anchor_1");
      expect(body.days).toBe(7);
      expect(body.series).toHaveLength(7);
      const today = body.series[body.series.length - 1];
      expect(today.date).toBe("2024-03-15");
      expect(today.morningConfirmationAt).toBe("2024-03-15T02:30:00.000Z");
      expect(today.sparshCount).toBe(1);
      expect(today.stepProgression).toBe(200);
      // Earlier days are zero-filled.
      expect(body.series[0].sparshCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a caller who does not observe the requested Anchor (403)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/vitality/rhythm?anchorId=stranger",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("emits no location field (R28.15)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/vitality/rhythm?days=2&anchorId=anchor_1",
        headers: { authorization: bearer(app, "observer_1") },
      });
      const day = res.json().series[0];
      for (const forbidden of ["location", "lat", "lng", "gps", "breadcrumbs"]) {
        expect(Object.keys(day)).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });

  it("requires authentication (401)", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/vitality/rhythm",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/web/vitality/voice-notes", () => {
  class SeededArchive implements VoiceNoteArchiveSource {
    constructor(private readonly entries: VoiceNoteArchiveEntry[]) {}
    async list(): Promise<VoiceNoteArchiveEntry[]> {
      return this.entries;
    }
  }

  it("surfaces Vitality_Pulse cards + audio clips newest-first (R28.14)", async () => {
    const { prisma } = makeFakePrisma({
      members: [
        { circleId: "c1", userId: "observer_1", role: "OBSERVER" },
        { circleId: "c1", userId: "anchor_1", role: "ANCHOR" },
      ],
      users: [{ id: "anchor_1", preferredName: "Amma" }],
      pulses: [
        { id: "p1", anchorId: "anchor_1", confirmedAt: new Date("2024-03-14T02:30:00.000Z") },
      ],
    });
    const archive = new SeededArchive([
      {
        id: "vn1",
        anchorId: "anchor_1",
        kind: "VOICE_NOTE",
        recordedAt: "2024-03-15T02:30:00.000Z",
        durationSeconds: 8,
        audioRef: "s3://clip/vn1",
      },
    ]);
    const app = await buildTestApp({ prisma, voiceNoteArchive: archive });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/vitality/voice-notes?anchorId=anchor_1",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toHaveLength(2);
      // Newest first: the audio clip (Mar 15) before the pulse card (Mar 14).
      expect(body.entries[0].kind).toBe("VOICE_NOTE");
      expect(body.entries[0].audioRef).toBe("s3://clip/vn1");
      expect(body.entries[1].kind).toBe("VITALITY_PULSE");
      expect(body.entries[1].preferredName).toBe("Amma");
    } finally {
      await app.close();
    }
  });

  it("requires authentication (401)", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/vitality/voice-notes",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

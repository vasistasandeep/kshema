/**
 * Unit tests for circle creation, invitation, and join routes (task 4.1).
 *
 * All hermetic: an in-memory invitation nonce store and a fake Prisma client
 * stand in for a live Redis / DB. Bearer tokens are minted with the app's own
 * `app.jwt` so the `app.authenticate` guard passes.
 *
 * Coverage:
 *   - `POST /circles` creates a Circle + founding member, initializes a TRIAL
 *     Subscription for 14 days, and returns a first invitation (R2.1, R2.2,
 *     R20.1).
 *   - `POST /circles/join` with a valid token adds a member with the requested
 *     role and records `observerPublicKeyPem` for an Observer (R2.3, R2.5,
 *     R2.8).
 *   - invalid / expired / already-redeemed tokens -> descriptive 400 (R2.4).
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";
import { InMemoryInvitationNonceStore } from "../services/invitation-store.js";

const VALID_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkeymaterialtestkey",
  "-----END PUBLIC KEY-----",
].join("\n");

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

function makeFakeEmitter(): EventEmitter {
  return {
    emit: vi.fn(async (_name: SentinelEventName, _payload: unknown) => undefined),
    close: vi.fn(async () => undefined),
  };
}

interface FakeCircleMember {
  id: string;
  circleId: string;
  userId: string;
  role: string;
  canTriggerIVR: boolean;
  canAccessBlackBox: boolean;
  observerPublicKeyPem: string | null;
}

interface FakeCircle {
  id: string;
  name: string;
}

interface FakeSubscription {
  id: string;
  circleId: string;
  tier: string;
  trialEndsAt: Date;
}

/**
 * Minimal fake Prisma covering the three surfaces the circle routes use:
 * `circle.create` (nested member + subscription), `circleMember.findFirst`,
 * and `circleMember.create` (with `@@unique([circleId, userId])` semantics).
 */
function makeFakePrisma() {
  const circles = new Map<string, FakeCircle>();
  const members: FakeCircleMember[] = [];
  const subscriptions: FakeSubscription[] = [];
  let seq = 0;
  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}_${seq}`;
  };

  const prisma = {
    circle: {
      create: vi.fn(
        async (args: {
          data: {
            name: string;
            members: {
              create: {
                userId: string;
                role: string;
                canTriggerIVR: boolean;
                canAccessBlackBox: boolean;
              };
            };
            subscription: { create: { tier: string; trialEndsAt: Date } };
          };
        }) => {
          const circle: FakeCircle = { id: nextId("circle"), name: args.data.name };
          circles.set(circle.id, circle);

          const m = args.data.members.create;
          members.push({
            id: nextId("member"),
            circleId: circle.id,
            userId: m.userId,
            role: m.role,
            canTriggerIVR: m.canTriggerIVR,
            canAccessBlackBox: m.canAccessBlackBox,
            observerPublicKeyPem: null,
          });

          const s = args.data.subscription.create;
          subscriptions.push({
            id: nextId("sub"),
            circleId: circle.id,
            tier: s.tier,
            trialEndsAt: s.trialEndsAt,
          });

          return circle;
        },
      ),
    },
    circleMember: {
      findFirst: vi.fn(
        async (args: {
          where: { circleId?: string; userId?: string; id?: string };
        }) =>
          members.find(
            (m) =>
              (args.where.circleId === undefined ||
                m.circleId === args.where.circleId) &&
              (args.where.userId === undefined ||
                m.userId === args.where.userId) &&
              (args.where.id === undefined || m.id === args.where.id),
          ) ?? null,
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: { canTriggerIVR?: boolean; canAccessBlackBox?: boolean };
        }) => {
          const member = members.find((m) => m.id === args.where.id);
          if (!member) {
            throw new Error("Record to update not found");
          }
          if (args.data.canTriggerIVR !== undefined) {
            member.canTriggerIVR = args.data.canTriggerIVR;
          }
          if (args.data.canAccessBlackBox !== undefined) {
            member.canAccessBlackBox = args.data.canAccessBlackBox;
          }
          return member;
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            circleId: string;
            userId: string;
            role: string;
            observerPublicKeyPem?: string;
          };
        }) => {
          const dup = members.find(
            (m) =>
              m.circleId === args.data.circleId &&
              m.userId === args.data.userId,
          );
          if (dup) {
            // Emulate the @@unique([circleId, userId]) violation.
            throw new Error("Unique constraint failed on circleId_userId");
          }
          const member: FakeCircleMember = {
            id: nextId("member"),
            circleId: args.data.circleId,
            userId: args.data.userId,
            role: args.data.role,
            canTriggerIVR: false,
            canAccessBlackBox: false,
            observerPublicKeyPem: args.data.observerPublicKeyPem ?? null,
          };
          members.push(member);
          return member;
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, circles, members, subscriptions };
}

async function buildTestApp(overrides: Partial<BuildAppOptions> = {}) {
  return buildApp({
    env: testEnv(),
    eventEmitter: makeFakeEmitter(),
    loggerEnabled: false,
    ...overrides,
  });
}

/** Mint a bearer token accepted by `app.authenticate`. */
function bearer(app: FastifyInstance, userId: string): string {
  const token = app.jwt.sign({ sub: userId, channel: "MOBILE" });
  return `Bearer ${token}`;
}

describe("POST /api/v1/circles", () => {
  it("creates a circle + founding member, a 14-day TRIAL, and a first invitation", async () => {
    const { prisma, members, subscriptions } = makeFakePrisma();
    const nowMs = 1_700_000_000_000;
    const app = await buildTestApp({ prisma, now: () => nowMs });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles",
        headers: { authorization: bearer(app, "user_1") },
        payload: { name: "Sharma Family" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.circleId).toBe("string");
      expect(body.name).toBe("Sharma Family");
      expect(typeof body.invitation.inviteToken).toBe("string");
      expect(typeof body.invitation.expiresAt).toBe("string");

      // Founding member persisted for the creator.
      expect(members).toHaveLength(1);
      expect(members[0]?.userId).toBe("user_1");
      expect(members[0]?.circleId).toBe(body.circleId);

      // TRIAL subscription initialized for exactly 14 days (R20.1).
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]?.tier).toBe("TRIAL");
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      expect(subscriptions[0]?.trialEndsAt.getTime()).toBe(nowMs + fourteenDaysMs);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles",
        payload: { name: "No Auth" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/circles/join", () => {
  async function createCircle(app: FastifyInstance, creator: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: { authorization: bearer(app, creator) },
      payload: { name: "Sharma Family" },
    });
    return res.json() as {
      circleId: string;
      invitation: { inviteToken: string; expiresAt: string };
    };
  }

  it("adds an Observer with the requested role and records observerPublicKeyPem", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const created = await createCircle(app, "user_1");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: {
          inviteToken: created.invitation.inviteToken,
          role: "OBSERVER",
          observerPublicKeyPem: VALID_PUBLIC_KEY_PEM,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBe("OBSERVER");
      expect(body.userId).toBe("user_2");

      const joined = members.find((m) => m.userId === "user_2");
      expect(joined?.role).toBe("OBSERVER");
      expect(joined?.observerPublicKeyPem).toBe(VALID_PUBLIC_KEY_PEM);
    } finally {
      await app.close();
    }
  });

  it("adds an Anchor without requiring an observer public key", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const created = await createCircle(app, "user_1");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: created.invitation.inviteToken, role: "ANCHOR" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe("ANCHOR");
      const joined = members.find((m) => m.userId === "user_2");
      expect(joined?.observerPublicKeyPem).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rejects a garbage / tampered token with a descriptive 400", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: "not-a-real-token", role: "OBSERVER" },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("Bad Request");
      expect(body.message.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an expired invitation with a descriptive 400", async () => {
    const { prisma } = makeFakePrisma();
    // Shared advanceable clock across the store and the routes.
    let nowMs = 1_700_000_000_000;
    const now = () => nowMs;
    const invitationStore = new InMemoryInvitationNonceStore(now);
    const app = await buildTestApp({ prisma, invitationStore, now });

    try {
      const created = await createCircle(app, "user_1");

      // Push past the default 7-day invitation lifetime.
      nowMs += 8 * 24 * 60 * 60 * 1000;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: {
          inviteToken: created.invitation.inviteToken,
          role: "OBSERVER",
          observerPublicKeyPem: VALID_PUBLIC_KEY_PEM,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Bad Request");
    } finally {
      await app.close();
    }
  });

  it("rejects a second redemption of a single-use invitation with a 400", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const created = await createCircle(app, "user_1");

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: created.invitation.inviteToken, role: "ANCHOR" },
      });
      expect(first.statusCode).toBe(200);

      // Replay the same token as a different user.
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_3") },
        payload: { inviteToken: created.invitation.inviteToken, role: "ANCHOR" },
      });

      expect(second.statusCode).toBe(400);
      expect(second.json().error).toBe("Bad Request");
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/circles/:id/invitations", () => {
  it("mints a further invitation for a member's circle", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/circles",
        headers: { authorization: bearer(app, "user_1") },
        payload: { name: "Sharma Family" },
      });
      const { circleId } = createRes.json();

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/circles/${circleId}/invitations`,
        headers: { authorization: bearer(app, "user_1") },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.inviteToken).toBe("string");
      expect(typeof body.expiresAt).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("rejects minting for a circle the caller is not a member of with a 400", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/circles",
        headers: { authorization: bearer(app, "user_1") },
        payload: { name: "Sharma Family" },
      });
      const { circleId } = createRes.json();

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/circles/${circleId}/invitations`,
        headers: { authorization: bearer(app, "stranger") },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Bad Request");
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /api/v1/circles/:id/members/:memberId", () => {
  /**
   * Set up a circle whose founding (SUPER) member is `creator`, then join a
   * second user with the given role so we have a non-SUPER target member to
   * manage. Returns the circle id plus the SUPER and target member records.
   */
  async function setup(
    app: FastifyInstance,
    members: FakeCircleMember[],
    creator: string,
    joiner: string,
    joinerRole: "ANCHOR" | "OBSERVER" | "MUTUAL" = "ANCHOR",
  ) {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: { authorization: bearer(app, creator) },
      payload: { name: "Sharma Family" },
    });
    const { circleId, invitation } = createRes.json() as {
      circleId: string;
      invitation: { inviteToken: string };
    };

    const joinRes = await app.inject({
      method: "POST",
      url: "/api/v1/circles/join",
      headers: { authorization: bearer(app, joiner) },
      payload: { inviteToken: invitation.inviteToken, role: joinerRole },
    });
    const { memberId: targetId } = joinRes.json() as { memberId: string };

    const superMember = members.find((m) => m.userId === creator);
    return { circleId, targetId, superMember };
  }

  it("lets a SUPER member update another member's permission flags", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const { circleId, targetId } = await setup(
        app,
        members,
        "super_user",
        "target_user",
      );

      // The joined target starts with both flags false.
      const before = members.find((m) => m.id === targetId);
      expect(before?.canTriggerIVR).toBe(false);
      expect(before?.canAccessBlackBox).toBe(false);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circleId}/members/${targetId}`,
        headers: { authorization: bearer(app, "super_user") },
        payload: { canTriggerIVR: true, canAccessBlackBox: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.memberId).toBe(targetId);
      expect(body.canTriggerIVR).toBe(true);
      expect(body.canAccessBlackBox).toBe(true);

      const after = members.find((m) => m.id === targetId);
      expect(after?.canTriggerIVR).toBe(true);
      expect(after?.canAccessBlackBox).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("applies only the permission flag present in the body", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const { circleId, targetId } = await setup(
        app,
        members,
        "super_user",
        "target_user",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circleId}/members/${targetId}`,
        headers: { authorization: bearer(app, "super_user") },
        payload: { canTriggerIVR: true },
      });

      expect(res.statusCode).toBe(200);
      const after = members.find((m) => m.id === targetId);
      expect(after?.canTriggerIVR).toBe(true);
      // Untouched flag stays at its prior (false) value.
      expect(after?.canAccessBlackBox).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects a non-SUPER caller with 403", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      // target_user joins as a plain Anchor (both flags false = not SUPER).
      const { circleId, targetId } = await setup(
        app,
        members,
        "super_user",
        "target_user",
      );

      // target_user tries to grant itself permissions — not SUPER -> 403.
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circleId}/members/${targetId}`,
        headers: { authorization: bearer(app, "target_user") },
        payload: { canTriggerIVR: true },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Forbidden");
      // No mutation happened.
      const after = members.find((m) => m.id === targetId);
      expect(after?.canTriggerIVR).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects a caller who is not a member of the circle with 403", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const { circleId, targetId } = await setup(
        app,
        members,
        "super_user",
        "target_user",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circleId}/members/${targetId}`,
        headers: { authorization: bearer(app, "stranger") },
        payload: { canTriggerIVR: true },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Forbidden");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for an unknown member id in the circle", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const { circleId } = await setup(
        app,
        members,
        "super_user",
        "target_user",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circleId}/members/does_not_exist`,
        headers: { authorization: bearer(app, "super_user") },
        payload: { canTriggerIVR: true },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Not Found");
    } finally {
      await app.close();
    }
  });

  it("rejects an empty permission body with a 400", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const { circleId, targetId } = await setup(
        app,
        members,
        "super_user",
        "target_user",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circleId}/members/${targetId}`,
        headers: { authorization: bearer(app, "super_user") },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

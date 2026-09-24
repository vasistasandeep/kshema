/**
 * Broader circle lifecycle + invitation-validation tests (task 4.3).
 *
 * Complements the core coverage in `circles.test.ts` (task 4.1). Focus here:
 *   - Role assignment across every CircleRole — joining as ANCHOR, OBSERVER,
 *     and MUTUAL each yields a member with exactly that role (R2.3, R2.5).
 *   - Mutual-role dual treatment — a MUTUAL joiner is Observer-facing (its
 *     `observerPublicKeyPem` is recorded, like an OBSERVER) AND the founding
 *     member is created as MUTUAL, so a MUTUAL member is treated as both an
 *     Anchor and an Observer within the Circle (R2.6).
 *   - Invalid invitation rejection with a descriptive 400 — tampered
 *     signature, a validly-signed token with the wrong `purpose` claim, a
 *     malformed / non-JWT token, and a token whose nonce was never issued
 *     (R2.4). These are additive to the garbage / expired / replay cases in
 *     `circles.test.ts`.
 *
 * Hermetic: an in-memory invitation nonce store and a fake Prisma client stand
 * in for a live Redis / DB. Bearer + invite tokens are minted with the app's
 * own `app.jwt` so guards and signature verification behave as in production.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";

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
 * Minimal fake Prisma mirroring the harness in `circles.test.ts`: covers
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
        async (args: { where: { circleId: string; userId: string } }) =>
          members.find(
            (m) =>
              m.circleId === args.where.circleId &&
              m.userId === args.where.userId,
          ) ?? null,
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

/** Create a circle as `creator` and return its id + first invitation. */
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

describe("POST /api/v1/circles/join — role assignment (R2.3, R2.5)", () => {
  // A joiner may take on any of the three CircleRoles; the persisted member
  // must carry exactly the role requested at redemption time.
  const cases: Array<{ role: "ANCHOR" | "OBSERVER" | "MUTUAL"; withKey: boolean }> = [
    { role: "ANCHOR", withKey: false },
    { role: "OBSERVER", withKey: true },
    { role: "MUTUAL", withKey: true },
  ];

  for (const { role, withKey } of cases) {
    it(`joins as ${role} and persists a member with that exact role`, async () => {
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
            role,
            ...(withKey ? { observerPublicKeyPem: VALID_PUBLIC_KEY_PEM } : {}),
          },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.role).toBe(role);
        expect(body.userId).toBe("user_2");

        const joined = members.find((m) => m.userId === "user_2");
        expect(joined?.role).toBe(role);
      } finally {
        await app.close();
      }
    });
  }
});

describe("POST /api/v1/circles/join — mutual-role dual treatment (R2.6)", () => {
  it("treats a MUTUAL joiner as Observer-facing by recording observerPublicKeyPem", async () => {
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
          role: "MUTUAL",
          observerPublicKeyPem: VALID_PUBLIC_KEY_PEM,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe("MUTUAL");

      // A MUTUAL member is Observer-facing (like an OBSERVER), so the public
      // key is recorded for later black-box key wrapping (R2.6 + R2.8).
      const joined = members.find((m) => m.userId === "user_2");
      expect(joined?.role).toBe("MUTUAL");
      expect(joined?.observerPublicKeyPem).toBe(VALID_PUBLIC_KEY_PEM);
    } finally {
      await app.close();
    }
  });

  it("creates the founding member as MUTUAL — both Anchor and Observer within the Circle", async () => {
    const { prisma, members } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const created = await createCircle(app, "user_1");

      // The circle creator is the founding (super) member: MUTUAL role with
      // full permissions, i.e. treated as both an Anchor and an Observer.
      const founder = members.find((m) => m.userId === "user_1");
      expect(founder?.circleId).toBe(created.circleId);
      expect(founder?.role).toBe("MUTUAL");
      expect(founder?.canTriggerIVR).toBe(true);
      expect(founder?.canAccessBlackBox).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/circles/join — invalid invitation rejection (R2.4)", () => {
  it("rejects a token whose signature has been tampered with (400)", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const created = await createCircle(app, "user_1");

      // Corrupt the signature segment so it decodes to different bytes while
      // keeping a JWT-shaped three-part token. We flip a character near the
      // START of the signature (not the last char): the final base64url char of
      // a 32-byte HS256 signature only carries the last 2 payload bits, so
      // swapping it can decode to the SAME bytes and still verify. Mutating an
      // early character always changes a full signature byte, guaranteeing the
      // HMAC no longer matches.
      const parts = created.invitation.inviteToken.split(".");
      const sig = parts[2] ?? "";
      const firstChar = sig.slice(0, 1);
      const swapped = firstChar === "A" ? "B" : "A";
      parts[2] = swapped + sig.slice(1);
      const tampered = parts.join(".");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: tampered, role: "ANCHOR" },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("Bad Request");
      expect(body.message.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a validly-signed token that is not a circle-invite (wrong purpose) (400)", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      // A well-formed, correctly-signed JWT that lacks the invite claim set
      // (e.g. an ordinary access token). Signature passes, but the purpose
      // guard must still reject it.
      const notAnInvite = app.jwt.sign({ sub: "user_2", channel: "MOBILE" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: notAnInvite, role: "ANCHOR" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Bad Request");
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed, non-JWT token (400)", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: "header.payload", role: "OBSERVER" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Bad Request");
    } finally {
      await app.close();
    }
  });

  it("rejects a correctly-signed invite whose nonce was never issued (400)", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      // Forge a token with the RIGHT shape and a valid signature, but a nonce
      // the store has never seen (single-use redeem must return false). This
      // exercises the nonce path independently of signature/expiry.
      // The invite payload is a distinct claim set from AccessTokenPayload
      // (mirrors the cast in circles.ts), so sign it through an untyped cast.
      const signInvite = app.jwt.sign as unknown as (
        payload: Record<string, unknown>,
      ) => string;
      const forged = signInvite({
        purpose: "circle-invite",
        circleId: "circle_never_created",
        nonce: "nonce-that-was-never-issued",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/circles/join",
        headers: { authorization: bearer(app, "user_2") },
        payload: { inviteToken: forged, role: "ANCHOR" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Bad Request");
    } finally {
      await app.close();
    }
  });
});

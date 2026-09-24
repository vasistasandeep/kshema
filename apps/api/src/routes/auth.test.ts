/**
 * Unit tests for OTP auth routes (task 3.2).
 *
 * Covers the happy path (request → verify → session + persisted User) and the
 * two 401 rejection paths (wrong code, expired code), all hermetic: a
 * capturing mock `SmsSender`, an in-memory challenge store, and a fake Prisma
 * client stand in for live SMS / Redis / DB (R1.1, R1.2, R1.3, R1.5, R1.6).
 */
import { describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";
import { InMemoryOtpChallengeStore } from "../services/otp-store.js";
import type { SmsMessage, SmsSender } from "../services/sms.js";

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

/** Capturing SMS sender: records every dispatched message. */
function makeCapturingSms() {
  const sent: SmsMessage[] = [];
  const sender: SmsSender = {
    send: vi.fn(async (message: SmsMessage) => {
      sent.push(message);
    }),
  };
  return { sender, sent };
}

/** Extract the numeric OTP from the SMS body the route dispatched. */
function extractOtp(body: string): string {
  const match = body.match(/(\d{6})/);
  if (!match?.[1]) {
    throw new Error(`no OTP found in SMS body: ${body}`);
  }
  return match[1];
}

/** In-memory User table backing a fake Prisma `user.upsert`. */
function makeFakePrisma() {
  const byPhone = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const prisma = {
    user: {
      upsert: vi.fn(
        async (args: {
          where: { phone: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = byPhone.get(args.where.phone);
          if (existing) {
            const merged = { ...existing, ...args.update };
            // Emulate Prisma `{ push }` array update semantics.
            const pt = (args.update as { pushTokens?: { push?: string } })
              .pushTokens;
            if (pt && typeof pt === "object" && "push" in pt) {
              merged.pushTokens = [
                ...((existing.pushTokens as string[]) ?? []),
                pt.push,
              ];
            }
            byPhone.set(args.where.phone, merged);
            return merged;
          }
          seq += 1;
          const created = { id: `user_${seq}`, ...args.create };
          byPhone.set(args.where.phone, created);
          return created;
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];
  return { prisma, byPhone };
}

async function buildTestApp(overrides: Partial<BuildAppOptions> = {}) {
  return buildApp({
    env: testEnv(),
    eventEmitter: makeFakeEmitter(),
    otpStore: new InMemoryOtpChallengeStore(),
    loggerEnabled: false,
    ...overrides,
  });
}

describe("POST /api/v1/auth/otp/request", () => {
  it("generates a hashed OTP challenge, dispatches SMS, and returns a challengeId", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { phone: "+919812345678" },
      });

      expect(res.statusCode).toBe(200);
      expect(typeof res.json().challengeId).toBe("string");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("+919812345678");
      // The dispatched body carries the plaintext code; nothing else does.
      expect(extractOtp(sent[0]!.body)).toMatch(/^\d{6}$/);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/auth/otp/verify", () => {
  it("verifies a correct code, upserts the User, and issues access + refresh tokens", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma, byPhone } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const requestRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { phone: "+919812345678" },
      });
      const { challengeId } = requestRes.json();
      const code = extractOtp(sent[0]!.body);

      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/verify",
        payload: {
          challengeId,
          code,
          clientPublicKeyPem: VALID_PUBLIC_KEY_PEM,
          preferredName: "Amma",
          timezone: "Asia/Kolkata",
          pushToken: "expo-push-token-1",
        },
      });

      expect(verifyRes.statusCode).toBe(200);
      const session = verifyRes.json();
      expect(session.userId).toBe("user_1");
      expect(typeof session.accessToken).toBe("string");
      expect(typeof session.refreshToken).toBe("string");
      expect(session.accessToken).not.toBe(session.refreshToken);
      expect(typeof session.expiresAt).toBe("string");

      // The User was persisted with public key / timezone / name / push token.
      const stored = byPhone.get("+919812345678");
      expect(stored).toBeDefined();
      expect(stored?.publicKeyPem).toBe(VALID_PUBLIC_KEY_PEM);
      expect(stored?.timezone).toBe("Asia/Kolkata");
      expect(stored?.preferredName).toBe("Amma");
      expect(stored?.pushTokens).toEqual(["expo-push-token-1"]);
    } finally {
      await app.close();
    }
  });

  it("rejects a wrong code with a descriptive 401", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const requestRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { phone: "+919812345678" },
      });
      const { challengeId } = requestRes.json();
      const correct = extractOtp(sent[0]!.body);
      const wrong = correct === "000000" ? "111111" : "000000";

      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/verify",
        payload: {
          challengeId,
          code: wrong,
          clientPublicKeyPem: VALID_PUBLIC_KEY_PEM,
          timezone: "Asia/Kolkata",
        },
      });

      expect(verifyRes.statusCode).toBe(401);
      expect(prisma!.user.upsert).not.toHaveBeenCalled();
      const body = verifyRes.json();
      expect(body.error).toBe("Unauthorized");
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an expired code with a descriptive 401", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma } = makeFakePrisma();

    // Advanceable fake clock shared by the store AND the route, so the
    // challenge's `expiresAt` and the verify-time `now()` use the same base.
    let nowMs = 1_700_000_000_000;
    const now = () => nowMs;
    const otpStore = new InMemoryOtpChallengeStore(now);

    const app = await buildTestApp({ prisma, smsSender: sender, otpStore, now });

    try {
      const requestRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { phone: "+919812345678" },
      });
      const { challengeId } = requestRes.json();
      const code = extractOtp(sent[0]!.body);

      // Push the clock past the default 5-minute OTP lifetime so the stored
      // challenge is expired at verify time.
      nowMs += 6 * 60 * 1000;

      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/verify",
        payload: {
          challengeId,
          code,
          clientPublicKeyPem: VALID_PUBLIC_KEY_PEM,
          timezone: "Asia/Kolkata",
        },
      });

      expect(verifyRes.statusCode).toBe(401);
      expect(prisma!.user.upsert).not.toHaveBeenCalled();
      const body = verifyRes.json();
      expect(body.error).toBe("Unauthorized");
      expect(typeof body.message).toBe("string");
    } finally {
      await app.close();
    }
  });
});

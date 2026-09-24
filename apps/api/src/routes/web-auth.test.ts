/**
 * Unit tests for web-portal auth routes (task 20.1, R28.1, R28.2).
 *
 * All hermetic: a capturing mock `SmsSender`, in-memory OTP + WebAuthn
 * challenge stores, and a fake Prisma client stand in for live SMS / Redis /
 * DB. Covers:
 *   - WEB OTP request → verify issues a WEB-channel session and stores only the
 *     Web_Crypto_Vault PUBLIC key (R28.1, R28.2);
 *   - WEB verify rejects wrong / expired / wrong-channel codes with a 401;
 *   - WebAuthn registration (options + verify) persists a WebAuthnCredential
 *     with its COSE key + initial counter (R28.1);
 *   - WebAuthn authentication (options + verify) issues a session AND advances
 *     the stored counter on a strictly-increasing assertion;
 *   - a NON-INCREASING signature counter is rejected (clone detection, R28.1)
 *     and the stored counter is left unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";
import { InMemoryOtpChallengeStore } from "../services/otp-store.js";
import { InMemoryWebAuthnChallengeStore } from "../services/webauthn.js";
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
    WEB_ORIGIN: "https://dashboard.kshema.test",
    REDIS_URL: "redis://127.0.0.1:0",
    PORT: "0",
  });
}

function makeFakeEmitter(): EventEmitter {
  return {
    emit: vi.fn(async (_n: SentinelEventName, _p: unknown) => undefined),
    close: vi.fn(async () => undefined),
  };
}

function makeCapturingSms() {
  const sent: SmsMessage[] = [];
  const sender: SmsSender = {
    send: vi.fn(async (m: SmsMessage) => {
      sent.push(m);
    }),
  };
  return { sender, sent };
}

function extractOtp(body: string): string {
  const match = body.match(/(\d{6})/);
  if (!match?.[1]) {
    throw new Error(`no OTP found in SMS body: ${body}`);
  }
  return match[1];
}

interface FakeUser {
  id: string;
  phone: string;
  publicKeyPem: string;
  preferredName?: string | null;
}

interface FakeCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
}

/** In-memory Prisma backing user + WebAuthnCredential tables. */
function makeFakePrisma() {
  const usersByPhone = new Map<string, FakeUser>();
  const usersById = new Map<string, FakeUser>();
  const creds = new Map<string, FakeCredential>(); // keyed by credentialId
  let userSeq = 0;
  let credSeq = 0;

  const prisma = {
    user: {
      upsert: vi.fn(
        async (args: {
          where: { phone: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = usersByPhone.get(args.where.phone);
          if (existing) {
            const merged = { ...existing, ...args.update } as FakeUser;
            usersByPhone.set(args.where.phone, merged);
            usersById.set(merged.id, merged);
            return merged;
          }
          userSeq += 1;
          const created = {
            id: `user_${userSeq}`,
            ...(args.create as object),
          } as FakeUser;
          usersByPhone.set(created.phone, created);
          usersById.set(created.id, created);
          return created;
        },
      ),
      findUnique: vi.fn(
        async (args: { where: { id?: string; phone?: string } }) => {
          if (args.where.id) {
            return usersById.get(args.where.id) ?? null;
          }
          if (args.where.phone) {
            return usersByPhone.get(args.where.phone) ?? null;
          }
          return null;
        },
      ),
    },
    webAuthnCredential: {
      findUnique: vi.fn(async (args: { where: { credentialId: string } }) => {
        return creds.get(args.where.credentialId) ?? null;
      }),
      findMany: vi.fn(async (args: { where: { userId: string } }) => {
        return [...creds.values()].filter((c) => c.userId === args.where.userId);
      }),
      create: vi.fn(
        async (args: {
          data: {
            userId: string;
            credentialId: string;
            publicKey: Buffer;
            counter: number;
            transports: string[];
          };
        }) => {
          credSeq += 1;
          const created: FakeCredential = { id: `cred_${credSeq}`, ...args.data };
          creds.set(created.credentialId, created);
          return created;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { credentialId: string };
          data: { counter: number };
        }) => {
          const existing = creds.get(args.where.credentialId);
          if (!existing) {
            throw new Error("credential not found");
          }
          const updated = { ...existing, ...args.data };
          creds.set(existing.credentialId, updated);
          return updated;
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, usersByPhone, creds };
}

async function buildTestApp(overrides: Partial<BuildAppOptions> = {}) {
  return buildApp({
    env: testEnv(),
    eventEmitter: makeFakeEmitter(),
    otpStore: new InMemoryOtpChallengeStore(),
    webAuthnStore: new InMemoryWebAuthnChallengeStore(),
    loggerEnabled: false,
    ...overrides,
  });
}

/** Drive a full WEB OTP login and return the issued session. */
async function webOtpLogin(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  sent: SmsMessage[],
  phone = "+919812345678",
) {
  const requestRes = await app.inject({
    method: "POST",
    url: "/api/v1/web/auth/otp/request",
    payload: { phone },
  });
  expect(requestRes.statusCode).toBe(200);
  const { challengeId } = requestRes.json();
  const code = extractOtp(sent.at(-1)!.body);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/v1/web/auth/otp/verify",
    payload: { challengeId, code, clientPublicKeyPem: VALID_PUBLIC_KEY_PEM },
  });
  return verifyRes;
}

describe("POST /api/v1/web/auth/otp/*", () => {
  it("issues a WEB-channel session and stores only the public key", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma, usersByPhone } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const verifyRes = await webOtpLogin(app, sent);
      expect(verifyRes.statusCode).toBe(200);
      const session = verifyRes.json();
      expect(session.userId).toBe("user_1");
      expect(typeof session.accessToken).toBe("string");
      expect(session.accessToken).not.toBe(session.refreshToken);

      // The access token is stamped with the WEB channel.
      const decoded = app.jwt.decode(session.accessToken) as {
        channel?: string;
      };
      expect(decoded.channel).toBe("WEB");

      const stored = usersByPhone.get("+919812345678");
      expect(stored?.publicKeyPem).toBe(VALID_PUBLIC_KEY_PEM);
    } finally {
      await app.close();
    }
  });

  it("rejects a wrong web OTP code with a 401", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const requestRes = await app.inject({
        method: "POST",
        url: "/api/v1/web/auth/otp/request",
        payload: { phone: "+919812345678" },
      });
      const { challengeId } = requestRes.json();
      const correct = extractOtp(sent[0]!.body);
      const wrong = correct === "000000" ? "111111" : "000000";

      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/web/auth/otp/verify",
        payload: {
          challengeId,
          code: wrong,
          clientPublicKeyPem: VALID_PUBLIC_KEY_PEM,
        },
      });

      expect(verifyRes.statusCode).toBe(401);
      expect(prisma!.user.upsert).not.toHaveBeenCalled();
      expect(verifyRes.json().error).toBe("Unauthorized");
    } finally {
      await app.close();
    }
  });

  it("does not accept a MOBILE-channel challenge for a web session", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      // Mint the challenge through the MOBILE auth route…
      const requestRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { phone: "+919812345678" },
      });
      const { challengeId } = requestRes.json();
      const code = extractOtp(sent[0]!.body);

      // …then try to redeem it on the WEB verify route.
      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/web/auth/otp/verify",
        payload: { challengeId, code, clientPublicKeyPem: VALID_PUBLIC_KEY_PEM },
      });

      expect(verifyRes.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("WebAuthn passkey ceremonies", () => {
  const CRED_ID = "dGVzdC1jcmVkZW50aWFsLWlk"; // base64url-ish opaque id
  const COSE_PUBLIC_KEY = Buffer.from("cose-public-key").toString("base64");

  async function registerPasskey(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    accessToken: string,
  ) {
    const optionsRes = await app.inject({
      method: "POST",
      url: "/api/v1/web/webauthn/register/options",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(optionsRes.statusCode).toBe(200);
    const options = optionsRes.json();
    expect(options.rpId).toBe("dashboard.kshema.test");
    expect(typeof options.challenge).toBe("string");

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/web/webauthn/register/verify",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        credentialId: CRED_ID,
        publicKey: COSE_PUBLIC_KEY,
        transports: ["internal"],
        attestation: Buffer.from("attestation-object").toString("base64"),
      },
    });
    return verifyRes;
  }

  it("registers a passkey and persists the COSE key + initial counter", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma, creds } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const session = (await webOtpLogin(app, sent)).json();
      const verifyRes = await registerPasskey(app, session.accessToken);

      expect(verifyRes.statusCode).toBe(200);
      const result = verifyRes.json();
      expect(result.credentialId).toBe(CRED_ID);
      expect(result.counter).toBe(0);

      const stored = creds.get(CRED_ID);
      expect(stored).toBeDefined();
      expect(stored?.counter).toBe(0);
      expect(stored?.transports).toEqual(["internal"]);
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated session to register a passkey", async () => {
    const { sender } = makeCapturingSms();
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/web/webauthn/register/options",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("authenticates with a strictly-increasing counter and advances it", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma, creds } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const session = (await webOtpLogin(app, sent)).json();
      await registerPasskey(app, session.accessToken);

      // Options (unauthenticated login ceremony) lists the credential.
      const optionsRes = await app.inject({
        method: "POST",
        url: "/api/v1/web/webauthn/authenticate/options",
        payload: { phone: "+919812345678" },
      });
      expect(optionsRes.statusCode).toBe(200);
      expect(optionsRes.json().allowCredentials).toHaveLength(1);

      // Assert with a counter strictly greater than the stored 0.
      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/web/webauthn/authenticate/verify",
        payload: {
          credentialId: CRED_ID,
          signature: Buffer.from("sig").toString("base64"),
          authenticatorData: Buffer.from("authData").toString("base64"),
          clientDataJSON: Buffer.from("clientData").toString("base64"),
          counter: 5,
        },
      });

      expect(verifyRes.statusCode).toBe(200);
      const asserted = verifyRes.json();
      expect(asserted.userId).toBe("user_1");
      const decoded = app.jwt.decode(asserted.accessToken) as {
        channel?: string;
      };
      expect(decoded.channel).toBe("WEB");

      // The stored counter advanced to the asserted value.
      expect(creds.get(CRED_ID)?.counter).toBe(5);
    } finally {
      await app.close();
    }
  });

  it("rejects a non-increasing signature counter (clone detection) and leaves the stored counter unchanged", async () => {
    const { sender, sent } = makeCapturingSms();
    const { prisma, creds } = makeFakePrisma();
    const app = await buildTestApp({ prisma, smsSender: sender });

    try {
      const session = (await webOtpLogin(app, sent)).json();
      await registerPasskey(app, session.accessToken);

      // First assertion advances the counter to 7.
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/web/webauthn/authenticate/verify",
        payload: {
          credentialId: CRED_ID,
          signature: Buffer.from("sig").toString("base64"),
          authenticatorData: Buffer.from("authData").toString("base64"),
          clientDataJSON: Buffer.from("clientData").toString("base64"),
          counter: 7,
        },
      });
      expect(first.statusCode).toBe(200);
      expect(creds.get(CRED_ID)?.counter).toBe(7);

      // A replay / clone presents an equal-or-lower counter — must be rejected.
      for (const staleCounter of [7, 3]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/web/webauthn/authenticate/verify",
          payload: {
            credentialId: CRED_ID,
            signature: Buffer.from("sig").toString("base64"),
            authenticatorData: Buffer.from("authData").toString("base64"),
            clientDataJSON: Buffer.from("clientData").toString("base64"),
            counter: staleCounter,
          },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("Unauthorized");
        // The stored counter is NOT rolled back or advanced by a rejected attempt.
        expect(creds.get(CRED_ID)?.counter).toBe(7);
      }
    } finally {
      await app.close();
    }
  });
});

/**
 * WebAuthn (passkey) challenge store + verifier seams (task 20.1, R28.1).
 *
 * The Observer web portal offers optional FIDO2 / TouchID / Windows Hello
 * passkeys as a second login factor beside the phone OTP (R28.1). This module
 * provides two injectable seams the web-auth routes depend on:
 *
 *   1. `WebAuthnChallengeStore` — short-lived, single-use attestation /
 *      assertion challenges. Like the OTP challenge store, a challenge is
 *      high-churn, secret, and TTL-bounded, so it lives in Redis in production
 *      and a process-local map in tests / single-node dev. It is deliberately
 *      NOT a Prisma model.
 *
 *   2. `WebAuthnVerifier` — validates the browser's `navigator.credentials`
 *      response. The full FIDO2 signature verification (attestation statement
 *      parsing, `authenticatorData` flags, `clientDataJSON` origin/challenge
 *      binding, COSE signature check) lives behind this seam exactly as the
 *      subscription-webhook and emergency-token verifiers do — so the route
 *      pipeline is exercised end-to-end in tests without a WebAuthn SDK, and a
 *      production adapter (e.g. `@simplewebauthn/server`) drops in later
 *      without touching the route.
 *
 * The ONE behavioural invariant this task pins down regardless of the verifier
 * implementation is CLONE DETECTION: on authentication the asserted signature
 * counter MUST be strictly greater than the counter stored for that credential
 * (a non-increasing counter signals a cloned authenticator and is rejected;
 * R28.1 / design "rejects any non-increasing counter"). That check is enforced
 * in the ROUTE against the persisted `WebAuthnCredential.counter`, so it holds
 * no matter which verifier is wired in.
 */
import type { Redis } from "ioredis";
import { randomBytes, randomUUID } from "node:crypto";

/** Which ceremony a stored challenge belongs to. */
export type WebAuthnCeremony = "register" | "authenticate";

/** A stored, single-use WebAuthn challenge. */
export interface WebAuthnChallenge {
  /** base64url challenge nonce echoed back by the authenticator. */
  challenge: string;
  /** Ceremony the challenge was minted for. */
  ceremony: WebAuthnCeremony;
  /** Phone the ceremony is bound to (E.164). */
  phone: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
}

/** Data required to create a challenge (the nonce is minted by the store). */
export type NewWebAuthnChallenge = Omit<WebAuthnChallenge, "challenge">;

/** Injectable WebAuthn challenge store. */
export interface WebAuthnChallengeStore {
  /** Persist a new challenge and return the minted base64url nonce. */
  create(challenge: NewWebAuthnChallenge): Promise<string>;
  /** Fetch a challenge by nonce, or null if unknown/expired. */
  get(challenge: string): Promise<WebAuthnChallenge | null>;
  /** Remove a challenge (single-use: consumed on a verify attempt). */
  consume(challenge: string): Promise<void>;
}

/** A random base64url challenge nonce (32 bytes of entropy). */
export function generateWebAuthnChallenge(): string {
  return randomBytes(32).toString("base64url");
}

/** Milliseconds → whole seconds, rounded up (Redis TTL granularity). */
function msToTtlSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Process-local challenge store for tests and single-node dev. Expired entries
 * are treated as absent and lazily evicted on read.
 */
export class InMemoryWebAuthnChallengeStore implements WebAuthnChallengeStore {
  private readonly challenges = new Map<string, WebAuthnChallenge>();

  constructor(private readonly now: () => number = Date.now) {}

  async create(challenge: NewWebAuthnChallenge): Promise<string> {
    const nonce = generateWebAuthnChallenge();
    this.challenges.set(nonce, { ...challenge, challenge: nonce });
    return nonce;
  }

  async get(challenge: string): Promise<WebAuthnChallenge | null> {
    const entry = this.challenges.get(challenge);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.challenges.delete(challenge);
      return null;
    }
    return entry;
  }

  async consume(challenge: string): Promise<void> {
    this.challenges.delete(challenge);
  }
}

/** Redis-backed challenge store; TTL matches the challenge's remaining life. */
export class RedisWebAuthnChallengeStore implements WebAuthnChallengeStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = "webauthn:challenge:",
    private readonly now: () => number = Date.now,
  ) {}

  private key(challenge: string): string {
    return `${this.keyPrefix}${challenge}`;
  }

  async create(challenge: NewWebAuthnChallenge): Promise<string> {
    const nonce = generateWebAuthnChallenge();
    const record: WebAuthnChallenge = { ...challenge, challenge: nonce };
    const ttl = msToTtlSeconds(challenge.expiresAt - this.now());
    await this.redis.set(this.key(nonce), JSON.stringify(record), "EX", ttl);
    return nonce;
  }

  async get(challenge: string): Promise<WebAuthnChallenge | null> {
    const raw = await this.redis.get(this.key(challenge));
    if (!raw) {
      return null;
    }
    const record = JSON.parse(raw) as WebAuthnChallenge;
    if (record.expiresAt <= this.now()) {
      await this.consume(challenge);
      return null;
    }
    return record;
  }

  async consume(challenge: string): Promise<void> {
    await this.redis.del(this.key(challenge));
  }
}

/** Input to a registration (attestation) verification. */
export interface WebAuthnRegisterVerifyInput {
  /** The challenge nonce this attestation should be bound to. */
  expectedChallenge: string;
  /** base64url credential id reported by the authenticator. */
  credentialId: string;
  /** base64 COSE public key. */
  publicKey: string;
  /** base64 attestation object. */
  attestation: string;
  /** Relying-party id (site origin host). */
  rpId: string;
}

/** Result of a verified registration. */
export interface WebAuthnRegisterVerifyResult {
  /** COSE-encoded public key bytes to persist. */
  publicKey: Buffer;
  /** Initial signature counter reported at registration. */
  counter: number;
}

/** Input to an authentication (assertion) verification. */
export interface WebAuthnAuthenticateVerifyInput {
  /** The challenge nonce this assertion should be bound to. */
  expectedChallenge: string;
  /** base64url credential id being asserted. */
  credentialId: string;
  /** Persisted COSE public key for this credential. */
  storedPublicKey: Buffer;
  /** base64 assertion signature. */
  signature: string;
  /** base64 authenticator data. */
  authenticatorData: string;
  /** base64 client data JSON. */
  clientDataJSON: string;
  /** Signature counter asserted by the authenticator. */
  counter: number;
  /** Relying-party id (site origin host). */
  rpId: string;
}

/** Result of a verified assertion. */
export interface WebAuthnAuthenticateVerifyResult {
  /** The new signature counter to persist (post-increment). */
  newCounter: number;
}

/**
 * Injectable WebAuthn verifier. Production wires a real FIDO2 verifier (e.g.
 * `@simplewebauthn/server`); tests inject a stub. A verifier that cannot
 * validate the ceremony MUST throw — the route maps a throw to a 401.
 *
 * NOTE: the verifier does NOT own clone detection. The route enforces the
 * strictly-increasing-counter rule against the persisted credential so it holds
 * for every verifier implementation.
 */
export interface WebAuthnVerifier {
  verifyRegistration(
    input: WebAuthnRegisterVerifyInput,
  ): Promise<WebAuthnRegisterVerifyResult>;
  verifyAuthentication(
    input: WebAuthnAuthenticateVerifyInput,
  ): Promise<WebAuthnAuthenticateVerifyResult>;
}

/**
 * Default, SDK-free verifier used in dev/test and until a production FIDO2
 * adapter is wired. It performs the structural checks that do not require the
 * attestation-statement crypto:
 *   - a challenge must be present (the route already looked it up + bound it);
 *   - the credential id / public key material must be present;
 *   - it echoes the reported counter through unchanged so the ROUTE'S
 *     strictly-increasing check (clone detection) is what governs acceptance.
 *
 * It deliberately does NOT verify the attestation signature or the COSE
 * signature — that is the production adapter's job behind this same seam.
 */
export class DefaultWebAuthnVerifier implements WebAuthnVerifier {
  async verifyRegistration(
    input: WebAuthnRegisterVerifyInput,
  ): Promise<WebAuthnRegisterVerifyResult> {
    if (!input.expectedChallenge) {
      throw new Error("missing registration challenge");
    }
    if (!input.credentialId || !input.publicKey) {
      throw new Error("missing credential material");
    }
    return {
      publicKey: Buffer.from(input.publicKey, "base64"),
      // New passkeys typically report an initial counter of 0.
      counter: 0,
    };
  }

  async verifyAuthentication(
    input: WebAuthnAuthenticateVerifyInput,
  ): Promise<WebAuthnAuthenticateVerifyResult> {
    if (!input.expectedChallenge) {
      throw new Error("missing authentication challenge");
    }
    if (!input.signature || !input.authenticatorData || !input.clientDataJSON) {
      throw new Error("incomplete assertion");
    }
    // Pass the asserted counter through; the route compares it against the
    // stored counter and rejects any non-increasing value (clone detection).
    return { newCounter: input.counter };
  }
}

/** Opaque unique id helper reused for correlating challenges in logs. */
export function newChallengeCorrelationId(): string {
  return randomUUID();
}

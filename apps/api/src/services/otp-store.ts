/**
 * OTP challenge store (R1.1, R1.3).
 *
 * The Prisma schema (owned by task 1.3) has no OTP-challenge model, and the
 * schema is intentionally not modified here. OTP challenges are short-lived,
 * high-churn, and secret, which makes a key/value store the natural home — so
 * the challenge lives in Redis in production (with TTL-based expiry) and in a
 * process-local map for tests and single-node dev.
 *
 * Only a HASHED OTP + salt + expiry is stored — never the plaintext code
 * (R1.3). The store is transport-agnostic: hashing happens in `otp-crypto.ts`
 * and the route decides code lifetime.
 */
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

/** Login channel a challenge was created for (mirrors LoginChannel). */
export type OtpChannel = "MOBILE" | "WEB";

/** A stored OTP challenge — the plaintext code is deliberately absent. */
export interface OtpChallenge {
  /** Opaque challenge id returned to the client. */
  challengeId: string;
  /** Phone number the OTP was sent to (E.164). */
  phone: string;
  /** Salted HMAC digest of the OTP (never the code itself). */
  codeHash: string;
  /** Per-challenge salt used to derive `codeHash`. */
  salt: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
  /** Channel the challenge was created on. */
  channel: OtpChannel;
}

/** Data required to create a challenge (challengeId is minted by the store). */
export type NewOtpChallenge = Omit<OtpChallenge, "challengeId">;

/** Injectable challenge store. */
export interface OtpChallengeStore {
  /** Persist a new challenge and return its generated id. */
  create(challenge: NewOtpChallenge): Promise<string>;
  /** Fetch a challenge by id, or null if unknown/expired. */
  get(challengeId: string): Promise<OtpChallenge | null>;
  /** Remove a challenge (single-use: consumed on a verify attempt). */
  consume(challengeId: string): Promise<void>;
}

/** Milliseconds → whole seconds, rounded up (Redis TTL granularity). */
function msToTtlSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Process-local store for tests and single-node dev. Expired entries are
 * treated as absent and lazily evicted on read.
 */
export class InMemoryOtpChallengeStore implements OtpChallengeStore {
  private readonly challenges = new Map<string, OtpChallenge>();

  constructor(private readonly now: () => number = Date.now) {}

  async create(challenge: NewOtpChallenge): Promise<string> {
    const challengeId = randomUUID();
    this.challenges.set(challengeId, { ...challenge, challengeId });
    return challengeId;
  }

  async get(challengeId: string): Promise<OtpChallenge | null> {
    const entry = this.challenges.get(challengeId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.challenges.delete(challengeId);
      return null;
    }
    return entry;
  }

  async consume(challengeId: string): Promise<void> {
    this.challenges.delete(challengeId);
  }
}

/**
 * Redis-backed store. Each challenge is a single JSON key with a TTL matching
 * its remaining lifetime, so Redis evicts expired challenges automatically and
 * `get()` on an expired/absent key returns null.
 */
export class RedisOtpChallengeStore implements OtpChallengeStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = "otp:challenge:",
    private readonly now: () => number = Date.now,
  ) {}

  private key(challengeId: string): string {
    return `${this.keyPrefix}${challengeId}`;
  }

  async create(challenge: NewOtpChallenge): Promise<string> {
    const challengeId = randomUUID();
    const record: OtpChallenge = { ...challenge, challengeId };
    const ttl = msToTtlSeconds(challenge.expiresAt - this.now());
    await this.redis.set(this.key(challengeId), JSON.stringify(record), "EX", ttl);
    return challengeId;
  }

  async get(challengeId: string): Promise<OtpChallenge | null> {
    const raw = await this.redis.get(this.key(challengeId));
    if (!raw) {
      return null;
    }
    const record = JSON.parse(raw) as OtpChallenge;
    if (record.expiresAt <= this.now()) {
      await this.consume(challengeId);
      return null;
    }
    return record;
  }

  async consume(challengeId: string): Promise<void> {
    await this.redis.del(this.key(challengeId));
  }
}

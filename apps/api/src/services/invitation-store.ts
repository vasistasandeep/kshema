/**
 * Invitation nonce store (R2.2, R2.3, R2.4).
 *
 * Design choice — signed JWT invitation + server-side single-use nonce:
 *
 * The Prisma schema (owned by task 1.3) has NO `Invitation` model and MUST NOT
 * be modified. Rather than add one, an invitation is a short-lived signed JWT
 * (via `app.jwt`) that self-encodes `{ circleId, nonce, exp }`. Signature +
 * `exp` give us tamper-evidence and expiry with zero storage; the JWT is
 * fully self-verifying, so a restart or a second API node validates it without
 * shared state.
 *
 * The ONE thing a signed token cannot express on its own is single redemption:
 * a valid, unexpired JWT could otherwise be replayed. So we track only a small
 * per-invite `nonce` here — never the raw token — and flip it from "issued" to
 * "redeemed" on join. This is the minimal server-side state needed to make an
 * invite single-use, and it mirrors the OTP challenge store: Redis in prod
 * (TTL-based auto-eviction matching the invite lifetime) and a process-local
 * map for tests / single-node dev.
 *
 * We deliberately store a HASH-free opaque nonce (a random id embedded in the
 * signed token) rather than the token itself, so the store never holds
 * redeemable credential material.
 */
import type { Redis } from "ioredis";

/** Lifecycle state of a single invitation nonce. */
export type InvitationNonceState = "ISSUED" | "REDEEMED";

/** Injectable single-use invitation nonce store. */
export interface InvitationNonceStore {
  /**
   * Record a freshly-minted invitation nonce as ISSUED, with a TTL matching
   * the token's remaining lifetime so the entry auto-expires alongside it.
   */
  issue(nonce: string, ttlMs: number): Promise<void>;
  /** Current state of a nonce, or null if unknown/expired. */
  status(nonce: string): Promise<InvitationNonceState | null>;
  /**
   * Atomically redeem a nonce. Returns true iff it was ISSUED and is now
   * marked REDEEMED; false if unknown/expired/already-redeemed. The atomicity
   * prevents two concurrent joins from both succeeding on one invite.
   */
  redeem(nonce: string): Promise<boolean>;
}

/** Milliseconds -> whole seconds, rounded up (Redis TTL granularity). */
function msToTtlSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Process-local store for tests and single-node dev. Expired entries are
 * treated as absent and lazily evicted on read.
 */
export class InMemoryInvitationNonceStore implements InvitationNonceStore {
  private readonly entries = new Map<
    string,
    { state: InvitationNonceState; expiresAt: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async issue(nonce: string, ttlMs: number): Promise<void> {
    this.entries.set(nonce, {
      state: "ISSUED",
      expiresAt: this.now() + ttlMs,
    });
  }

  async status(nonce: string): Promise<InvitationNonceState | null> {
    const entry = this.entries.get(nonce);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(nonce);
      return null;
    }
    return entry.state;
  }

  async redeem(nonce: string): Promise<boolean> {
    const entry = this.entries.get(nonce);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(nonce);
      return false;
    }
    if (entry.state !== "ISSUED") {
      return false;
    }
    entry.state = "REDEEMED";
    this.entries.set(nonce, entry);
    return true;
  }
}

/**
 * Redis-backed store. Each nonce is a single key holding its state with a TTL
 * matching the invite lifetime, so Redis evicts it automatically once the
 * invitation would have expired anyway.
 *
 * `redeem` uses a compare-and-set Lua script so the "is it still ISSUED?" read
 * and the "mark REDEEMED" write are one atomic step — two concurrent joins
 * cannot both win.
 */
export class RedisInvitationNonceStore implements InvitationNonceStore {
  // KEYS[1] = nonce key. Returns 1 iff the value was "ISSUED" and was flipped
  // to "REDEEMED" (preserving the remaining TTL); 0 otherwise.
  private static readonly REDEEM_LUA = `
    if redis.call('GET', KEYS[1]) == 'ISSUED' then
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl and ttl > 0 then
        redis.call('SET', KEYS[1], 'REDEEMED', 'PX', ttl)
      else
        redis.call('SET', KEYS[1], 'REDEEMED')
      end
      return 1
    end
    return 0
  `;

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = "circle:invite:",
  ) {}

  private key(nonce: string): string {
    return `${this.keyPrefix}${nonce}`;
  }

  async issue(nonce: string, ttlMs: number): Promise<void> {
    await this.redis.set(this.key(nonce), "ISSUED", "EX", msToTtlSeconds(ttlMs));
  }

  async status(nonce: string): Promise<InvitationNonceState | null> {
    const raw = await this.redis.get(this.key(nonce));
    if (raw === "ISSUED" || raw === "REDEEMED") {
      return raw;
    }
    return null;
  }

  async redeem(nonce: string): Promise<boolean> {
    const result = await this.redis.eval(
      RedisInvitationNonceStore.REDEEM_LUA,
      1,
      this.key(nonce),
    );
    return result === 1;
  }
}

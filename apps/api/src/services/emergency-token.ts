/**
 * Emergency_Access_Token minting service (task 13.1 — R29.1, R29.2, R29.3).
 *
 * The GENERATION half of the Ephemeral_Responder_Portal access control. When a
 * Safety_Incident reaches STAGE_4_HYPERLOCAL_DISPATCH the API mints a
 * short-lived, single-incident-bound, cryptographically-signed token, embeds it
 * in a shortened HTTPS responder-portal URL, and delivers that URL via priority
 * SMS + WhatsApp to the gate guard and neighbor contacts (R29.3).
 *
 * The responder-portal fetch/verify (`GET /emergency/:token`) is a SEPARATE
 * task (13.3); this module only mints, persists, and delivers.
 *
 * Zero-knowledge storage invariant (R29.2, design "EmergencyAccessToken stores
 * only a hash of the signed token"):
 *   - the RAW signed token is delivered out-of-band (SMS + WhatsApp) and is
 *     NEVER persisted;
 *   - the `EmergencyAccessToken` row stores ONLY `tokenHash = hash(rawToken)`.
 *     Verification (task 13.3) recomputes the hash from the presented token and
 *     looks the row up by `tokenHash`, so the server can validate a token it
 *     never stored.
 *
 * Everything that touches the outside world is behind an injectable seam so the
 * unit tests stay hermetic:
 *   - {@link TokenSigner} — signs the JWT bound to `incidentId` + expiry (the
 *     production wiring closes over `app.jwt.sign`);
 *   - {@link EmergencyTokenStore} — persists / reads the hash-only row (Prisma
 *     in production, an in-memory fake in tests);
 *   - {@link EmergencyLinkDelivery} — sends the shortened URL over SMS and
 *     WhatsApp (a capturing fake in tests);
 *   - the clock (`now`) and `hashToken` are injectable/pure.
 */
import { createHash } from "node:crypto";

/** Read-only triage scope embedded in the token + persisted on the row (R29.2). */
export const EMERGENCY_TRIAGE_SCOPE = "EMERGENCY_TRIAGE_READ" as const;

/** Hard cap on token lifetime: at most 60 minutes (R29.2). */
export const MAX_EMERGENCY_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Default token lifetime — the maximum permitted 60 minutes (R29.2). */
export const DEFAULT_EMERGENCY_TOKEN_TTL_MS = MAX_EMERGENCY_TOKEN_TTL_MS;

/**
 * The signed JWT claim set. Bound to exactly one incident (R29.1) and carrying
 * an explicit read-only scope + expiry (R29.2). `iat`/`exp` are seconds
 * (standard JWT), mirrored by the row's `expiresAt` in the store.
 */
export interface EmergencyTokenClaims {
  /** Single-incident binding (R29.1). */
  incidentId: string;
  /** Read-only triage scope (R29.2). */
  scope: typeof EMERGENCY_TRIAGE_SCOPE;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds; `exp - iat <= 60m` (R29.2). */
  exp: number;
}

/**
 * Signs an emergency token from its claims and returns the compact serialized
 * token string. Production wiring closes over `@fastify/jwt`'s `app.jwt.sign`;
 * tests pass a deterministic fake.
 */
export type TokenSigner = (claims: EmergencyTokenClaims) => string;

/** The hash-only persistence port for {@link EmergencyAccessToken} rows. */
export interface EmergencyTokenStore {
  /**
   * Persist a new hash-only token row. Implementations MUST store only
   * `tokenHash` (never the raw token). The row is uniquely keyed on
   * `incidentId` (R29.1) — a re-mint for an already-tokened incident should be
   * an upsert on `incidentId`.
   */
  persist(row: {
    incidentId: string;
    tokenHash: string;
    scope: string;
    expiresAt: Date;
  }): Promise<void>;
}

/** A shortened responder-portal HTTPS URL carrying the token (R29.3). */
export interface EmergencyLink {
  /** The full shortened HTTPS URL delivered to responders. */
  url: string;
  /** The raw signed token embedded in the URL. Never persisted. */
  rawToken: string;
}

/** One delivery target for the emergency link (gate guard / neighbor, R29.3). */
export interface EmergencyLinkRecipient {
  /** Stable id for audit/logging correlation (e.g. "society-gate"). */
  id: string;
  /** E.164 phone number to deliver the SMS + WhatsApp to. */
  phone: string;
}

/**
 * Delivers the shortened responder-portal URL over BOTH priority SMS and
 * WhatsApp (R29.3). Split into two methods so the API can reuse the existing
 * {@link import("./sms.js").SmsSender} seam for SMS while WhatsApp goes through
 * the carrier gateway; tests capture both channels.
 */
export interface EmergencyLinkDelivery {
  /** Deliver the URL via priority SMS. */
  sendSms(input: { to: string; url: string; incidentId: string }): Promise<void>;
  /** Deliver the URL via WhatsApp. */
  sendWhatsApp(input: {
    to: string;
    url: string;
    incidentId: string;
  }): Promise<void>;
}

/**
 * Builds the shortened HTTPS responder-portal URL for a raw token (R29.3). The
 * default appends the token to the configured base; a real URL-shortener slots
 * in behind the same seam.
 */
export type EmergencyLinkBuilder = (rawToken: string) => string;

/** Dependencies for {@link mintEmergencyAccessToken}. */
export interface EmergencyTokenDeps {
  /** Signs the JWT (production: `app.jwt.sign`). */
  sign: TokenSigner;
  /** Persists the hash-only row. */
  store: EmergencyTokenStore;
  /** Delivers the link over SMS + WhatsApp. */
  delivery: EmergencyLinkDelivery;
  /** Builds the shortened responder-portal URL from the raw token. */
  buildLink: EmergencyLinkBuilder;
  /** Injectable clock (epoch-ms); defaults to `Date.now`. */
  now?: () => number;
  /** Token lifetime in ms; clamped to <= 60m (R29.2). Defaults to 60m. */
  ttlMs?: number;
  /** Token hasher; defaults to SHA-256 hex. Must match the verifier (13.3). */
  hashToken?: (rawToken: string) => string;
}

/** Inputs to mint + deliver an emergency access token. */
export interface MintEmergencyTokenInput {
  /** The incident the token is bound to (R29.1). */
  incidentId: string;
  /**
   * The gate guard + neighbor contacts to deliver the link to (R29.3). The
   * Primary Observer is dialed directly (R14.1) and is not a link recipient.
   */
  recipients: readonly EmergencyLinkRecipient[];
}

/** Result of {@link mintEmergencyAccessToken}. */
export interface MintEmergencyTokenResult {
  /** The incident the token is bound to. */
  incidentId: string;
  /** SHA-256 (hex) hash of the raw token — the ONLY thing persisted (R29.2). */
  tokenHash: string;
  /** Read-only triage scope stamped on the row + claims (R29.2). */
  scope: typeof EMERGENCY_TRIAGE_SCOPE;
  /** Expiry as a Date; `expiresAt <= now + 60m` (R29.2). */
  expiresAt: Date;
  /** The shortened responder-portal URL delivered to recipients (R29.3). */
  url: string;
  /**
   * The raw signed token. Returned to the caller for out-of-band delivery ONLY;
   * it is NEVER persisted. Callers must not store it.
   */
  rawToken: string;
  /** The recipient ids the link was delivered to (both SMS + WhatsApp). */
  deliveredTo: string[];
}

/** Default SHA-256 hex token hasher. Must match the verifier (task 13.3). */
export function hashEmergencyToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Mint a signed, single-incident-bound Emergency_Access_Token, persist ONLY its
 * hash, and deliver the shortened responder-portal URL via SMS + WhatsApp
 * (R29.1, R29.2, R29.3).
 *
 * Steps:
 *   1. Compute the issue/expiry window, clamping the TTL to <= 60 minutes so
 *      the token is valid for at most an hour (R29.2).
 *   2. Sign a JWT bound to `incidentId` with the read-only scope (R29.1/R29.2).
 *   3. Hash the raw token and persist ONLY the hash + scope + expiry, keyed on
 *      the incident (R29.2 — the raw token never touches the DB).
 *   4. Build the shortened HTTPS URL and deliver it to every recipient over
 *      BOTH priority SMS and WhatsApp (R29.3).
 *
 * Returns the raw token to the caller solely for out-of-band delivery; the
 * caller must never persist it.
 */
export async function mintEmergencyAccessToken(
  deps: EmergencyTokenDeps,
  input: MintEmergencyTokenInput,
): Promise<MintEmergencyTokenResult> {
  const now = deps.now ?? (() => Date.now());
  const hashToken = deps.hashToken ?? hashEmergencyToken;

  // Clamp the lifetime to <= 60 minutes (R29.2). A caller can request a shorter
  // TTL, but never a longer one.
  const requestedTtl = deps.ttlMs ?? DEFAULT_EMERGENCY_TOKEN_TTL_MS;
  const ttlMs = Math.min(Math.max(0, requestedTtl), MAX_EMERGENCY_TOKEN_TTL_MS);

  const nowMs = now();
  const iatSec = Math.floor(nowMs / 1000);
  const expiresAtMs = nowMs + ttlMs;
  const expSec = Math.floor(expiresAtMs / 1000);

  const claims: EmergencyTokenClaims = {
    incidentId: input.incidentId,
    scope: EMERGENCY_TRIAGE_SCOPE,
    iat: iatSec,
    exp: expSec,
  };

  // 2. Sign the token (raw — never persisted).
  const rawToken = deps.sign(claims);

  // 3. Persist ONLY the hash (R29.2). Store expiry from the ms window so it is
  //    exact rather than truncated to whole seconds.
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(expiresAtMs);
  await deps.store.persist({
    incidentId: input.incidentId,
    tokenHash,
    scope: EMERGENCY_TRIAGE_SCOPE,
    expiresAt,
  });

  // 4. Build the shortened URL and deliver it over SMS + WhatsApp (R29.3).
  const url = deps.buildLink(rawToken);
  const deliveredTo: string[] = [];
  for (const recipient of input.recipients) {
    await deps.delivery.sendSms({
      to: recipient.phone,
      url,
      incidentId: input.incidentId,
    });
    await deps.delivery.sendWhatsApp({
      to: recipient.phone,
      url,
      incidentId: input.incidentId,
    });
    deliveredTo.push(recipient.id);
  }

  return {
    incidentId: input.incidentId,
    tokenHash,
    scope: EMERGENCY_TRIAGE_SCOPE,
    expiresAt,
    url,
    rawToken,
    deliveredTo,
  };
}

// ---------------------------------------------------------------------------
// Default seam implementations (production wiring). Kept here so the route/
// worker glue is thin; tests inject fakes instead.
// ---------------------------------------------------------------------------

/**
 * A Prisma-backed {@link EmergencyTokenStore}. Upserts on the unique
 * `incidentId` so a re-mint for the same incident replaces the prior hash
 * rather than violating the unique constraint. Persists ONLY the hash (R29.2).
 *
 * Typed against a structural subset of the Prisma client so this module does
 * not force a `@kshema/database` type import into the pure logic above; the
 * real `PrismaClient` satisfies it.
 */
export interface PrismaEmergencyTokenDelegate {
  emergencyAccessToken: {
    upsert(args: {
      where: { incidentId: string };
      create: {
        incidentId: string;
        tokenHash: string;
        scope: string;
        expiresAt: Date;
      };
      update: { tokenHash: string; scope: string; expiresAt: Date };
    }): Promise<unknown>;
  };
}

/** Build a Prisma-backed hash-only token store. */
export function createPrismaEmergencyTokenStore(
  prisma: PrismaEmergencyTokenDelegate,
): EmergencyTokenStore {
  return {
    async persist(row) {
      await prisma.emergencyAccessToken.upsert({
        where: { incidentId: row.incidentId },
        create: {
          incidentId: row.incidentId,
          tokenHash: row.tokenHash,
          scope: row.scope,
          expiresAt: row.expiresAt,
        },
        update: {
          tokenHash: row.tokenHash,
          scope: row.scope,
          expiresAt: row.expiresAt,
        },
      });
    },
  };
}

/** Options for {@link createDefaultEmergencyLinkBuilder}. */
export interface EmergencyLinkBuilderOptions {
  /** Base responder-portal URL, e.g. `https://k.sh/e`. */
  baseUrl: string;
}

/**
 * Default link builder: appends the token to the base as a path segment. A real
 * URL-shortener (returning a `https://k.sh/<slug>` handle) can replace this
 * behind the {@link EmergencyLinkBuilder} seam without touching the mint logic.
 */
export function createDefaultEmergencyLinkBuilder(
  opts: EmergencyLinkBuilderOptions,
): EmergencyLinkBuilder {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return (rawToken: string) => `${base}/${encodeURIComponent(rawToken)}`;
}

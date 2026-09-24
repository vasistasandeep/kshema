/**
 * @kshema/types — web portal DTOs (R28).
 *
 * Web auth verify accepts only `clientPublicKeyPem` from the Web_Crypto_Vault
 * — never a private key (R28.2). WebAuthn stores COSE public keys + a
 * non-decreasing signature counter. Vitality history excludes location
 * breadcrumbs (R28.15). `.strict()` enforces both invariants.
 */
import { z } from "zod";
import {
  BillingIntervalSchema,
  IncidentStageSchema,
  SubscriptionTierSchema,
  WellBeingStateSchema,
} from "./enums.js";
import {
  Base64,
  Id,
  IsoDateTime,
  NonEmptyString,
  PhoneNumber,
  PublicKeyPem,
} from "./common.js";

// --- Web OTP (login channel WEB) ---
export const WebOtpRequestSchema = z
  .object({
    phone: PhoneNumber,
  })
  .strict();
export type WebOtpRequest = z.infer<typeof WebOtpRequestSchema>;

/** Accepts only the Web_Crypto_Vault PUBLIC key (R28.2). */
export const WebOtpVerifySchema = z
  .object({
    challengeId: NonEmptyString,
    code: z.string().trim().min(4).max(10),
    clientPublicKeyPem: PublicKeyPem,
  })
  .strict();
export type WebOtpVerify = z.infer<typeof WebOtpVerifySchema>;

// --- Web auth session (login channel WEB) ---
/**
 * Session issued after a successful web OTP or WebAuthn assertion. Mirrors the
 * mobile `AuthSession` but is scoped to the browser (login channel WEB, R28.1).
 */
export const WebAuthSessionSchema = z
  .object({
    userId: NonEmptyString,
    accessToken: NonEmptyString,
    refreshToken: NonEmptyString,
    expiresAt: IsoDateTime,
  })
  .strict();
export type WebAuthSession = z.infer<typeof WebAuthSessionSchema>;

// --- WebAuthn (passkey) ---
export const WebAuthnRegisterOptionsRequestSchema = z.object({}).strict();
export type WebAuthnRegisterOptionsRequest = z.infer<
  typeof WebAuthnRegisterOptionsRequestSchema
>;

/**
 * FIDO2 attestation (registration) options handed to the browser for
 * `navigator.credentials.create()`. `challenge` is a base64url nonce the
 * server also stashes server-side for the matching verify call (R28.1).
 */
export const WebAuthnRegisterOptionsResponseSchema = z
  .object({
    challenge: NonEmptyString,
    rpId: NonEmptyString,
    rpName: NonEmptyString,
    userId: NonEmptyString,
    userName: NonEmptyString,
    timeoutMs: z.number().int().positive(),
    attestation: z.literal("none"),
    pubKeyCredParams: z.array(
      z.object({ type: z.literal("public-key"), alg: z.number().int() }),
    ),
  })
  .strict();
export type WebAuthnRegisterOptionsResponse = z.infer<
  typeof WebAuthnRegisterOptionsResponseSchema
>;

/** Result of a successful passkey registration (R28.1). */
export const WebAuthnRegisterResultSchema = z
  .object({
    credentialId: NonEmptyString,
    counter: z.number().int().min(0),
  })
  .strict();
export type WebAuthnRegisterResult = z.infer<
  typeof WebAuthnRegisterResultSchema
>;

/** Assertion (authentication) options for `navigator.credentials.get()`. */
export const WebAuthnAuthenticateOptionsRequestSchema = z
  .object({
    phone: PhoneNumber,
  })
  .strict();
export type WebAuthnAuthenticateOptionsRequest = z.infer<
  typeof WebAuthnAuthenticateOptionsRequestSchema
>;

export const WebAuthnAuthenticateOptionsResponseSchema = z
  .object({
    challenge: NonEmptyString,
    rpId: NonEmptyString,
    timeoutMs: z.number().int().positive(),
    allowCredentials: z.array(
      z.object({
        id: NonEmptyString,
        type: z.literal("public-key"),
        transports: z.array(NonEmptyString).default([]),
      }),
    ),
  })
  .strict();
export type WebAuthnAuthenticateOptionsResponse = z.infer<
  typeof WebAuthnAuthenticateOptionsResponseSchema
>;

export const WebAuthnRegisterVerifySchema = z
  .object({
    credentialId: NonEmptyString,
    publicKey: Base64,
    transports: z.array(NonEmptyString).default([]),
    attestation: Base64,
  })
  .strict();
export type WebAuthnRegisterVerify = z.infer<typeof WebAuthnRegisterVerifySchema>;

export const WebAuthnAuthenticateVerifySchema = z
  .object({
    credentialId: NonEmptyString,
    signature: Base64,
    authenticatorData: Base64,
    clientDataJSON: Base64,
    counter: z.number().int().min(0),
  })
  .strict();
export type WebAuthnAuthenticateVerify = z.infer<
  typeof WebAuthnAuthenticateVerifySchema
>;

// --- Vitality history (no location breadcrumb; R28.15) ---
export const VitalityRhythmQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
  })
  .strict();
export type VitalityRhythmQuery = z.infer<typeof VitalityRhythmQuerySchema>;

export const VitalityRhythmDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    morningConfirmationAt: IsoDateTime.optional(),
    sparshCount: z.number().int().min(0).default(0),
    stepProgression: z.number().int().min(0).optional(),
  })
  .strict();
export type VitalityRhythmDay = z.infer<typeof VitalityRhythmDaySchema>;

/**
 * 30-day connection-rhythm calendar response (R28.13). A dense per-day series
 * of morning confirmation times, Sparsh interaction counts, and step
 * progression, over the requested window. Carries NO location breadcrumb
 * (R28.15) — the `.strict()` DTO forbids any location field.
 */
export const VitalityRhythmResponseSchema = z
  .object({
    days: z.number().int().min(1),
    anchorId: Id,
    series: z.array(VitalityRhythmDaySchema).default([]),
  })
  .strict();
export type VitalityRhythmResponse = z.infer<
  typeof VitalityRhythmResponseSchema
>;

/**
 * One archived micro-voice reply (≤10s) or Vitality_Pulse card for playback
 * (R28.14). `audioRef` is the object-store reference the browser fetches the
 * ≤10s clip from; a `Vitality_Pulse` card has no audio. Carries no location.
 */
export const VoiceNoteArchiveEntrySchema = z
  .object({
    id: Id,
    anchorId: Id,
    kind: z.enum(["VOICE_NOTE", "VITALITY_PULSE"]),
    recordedAt: IsoDateTime,
    durationSeconds: z.number().min(0).max(10).optional(),
    audioRef: NonEmptyString.optional(),
    preferredName: NonEmptyString.optional(),
  })
  .strict();
export type VoiceNoteArchiveEntry = z.infer<
  typeof VoiceNoteArchiveEntrySchema
>;

/** Archived micro-voice replies + Vitality_Pulse cards for playback (R28.14). */
export const VoiceNoteArchiveResponseSchema = z
  .object({
    entries: z.array(VoiceNoteArchiveEntrySchema).default([]),
  })
  .strict();
export type VoiceNoteArchiveResponse = z.infer<
  typeof VoiceNoteArchiveResponseSchema
>;

// --- Billing self-service (R28.16, R28.17) ---
export const BillingPortalSessionResponseSchema = z
  .object({
    redirectUrl: NonEmptyString,
  })
  .strict();
export type BillingPortalSessionResponse = z.infer<
  typeof BillingPortalSessionResponseSchema
>;

export const BillingSummarySchema = z
  .object({
    tier: SubscriptionTierSchema,
    interval: BillingIntervalSchema.optional(),
    trialEndsAt: IsoDateTime,
    trialDaysRemaining: z.number().int().min(0),
  })
  .strict();
export type BillingSummary = z.infer<typeof BillingSummarySchema>;

export const BillingIntervalSwitchSchema = z
  .object({
    interval: BillingIntervalSchema,
  })
  .strict();
export type BillingIntervalSwitch = z.infer<typeof BillingIntervalSwitchSchema>;

export const InvoiceSummarySchema = z
  .object({
    id: Id,
    issuedAt: IsoDateTime,
    amountMinor: z.number().int().min(0),
    currency: z.string().length(3),
    /** Direct download URL for the tax-compliant PDF (R28.17). */
    pdfUrl: NonEmptyString.optional(),
  })
  .strict();
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

/** List of tax-compliant invoices for self-service download (R28.17). */
export const InvoiceListResponseSchema = z
  .object({
    invoices: z.array(InvoiceSummarySchema).default([]),
  })
  .strict();
export type InvoiceListResponse = z.infer<typeof InvoiceListResponseSchema>;

/** `:id.pdf` path param for the invoice download route (R28.17). */
export const InvoiceIdParamSchema = z
  .object({
    // The route path is `/web/billing/invoices/:id.pdf`; Fastify captures the
    // `id.pdf` segment, so the param carries the trailing `.pdf` which the
    // handler strips.
    id: NonEmptyString,
  })
  .strict();
export type InvoiceIdParam = z.infer<typeof InvoiceIdParamSchema>;

// --- Dashboard SSE tick + snapshot (R28.5-28.9) ---
/**
 * One per-Anchor entry pushed over the dashboard stream: derived well-being
 * state, the active Escalation_Stage when escalating, the last confirmation
 * time, and a dual-timezone tick contrasting the Observer's local time with
 * the Anchor's local time (R28.6, R28.7, R28.8). Carries NO location trace
 * (R28.15) — `.strict()` forbids any location field.
 */
export const DashboardTickSchema = z
  .object({
    anchorId: Id,
    preferredName: NonEmptyString,
    state: WellBeingStateSchema,
    escalationStage: IncidentStageSchema.optional(),
    lastConfirmationAt: IsoDateTime.optional(),
    /** Observer's wall-clock time at emission (R28.6). */
    observerTime: IsoDateTime,
    /** Anchor's wall-clock time at emission, in the Anchor's timezone (R28.6). */
    anchorTime: IsoDateTime,
    /** IANA timezone id the `anchorTime` is expressed in. */
    anchorTimezone: NonEmptyString,
  })
  .strict();
export type DashboardTick = z.infer<typeof DashboardTickSchema>;

/**
 * A full dashboard snapshot: every Anchor the Observer watches plus the tick
 * timestamp. Emitted as the initial SSE frame and returned verbatim by the
 * WebSocket-fallback snapshot endpoint (R28.5, R28.9). Silent background
 * refresh needs no page reload — the client applies each frame in place.
 */
export const DashboardSnapshotSchema = z
  .object({
    observerTime: IsoDateTime,
    anchors: z.array(DashboardTickSchema).default([]),
  })
  .strict();
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;

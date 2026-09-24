/**
 * Ephemeral first-responder emergency portal routes (task 13.3 — R29.6, R29.7,
 * R29.9, R29.10, R29.11, R29.12, R33.3, R33.4).
 *
 * Mounted under `/api/v1`, so the effective paths are:
 *   - `GET  /api/v1/emergency/:token`          read-only triage payload
 *   - `POST /api/v1/emergency/:token/confirm`  responder-confirms → resolve
 *
 * ZERO-LOGIN, TOKEN-GATED (R29.4). Neither route requires a bearer token. The
 * signed `Emergency_Access_Token` carried in the URL path is the SOLE
 * credential: it is verified for signature + expiry (JWT `exp`), matched to a
 * persisted hash-only `EmergencyAccessToken` row (the raw token is never
 * stored — see `services/emergency-token.ts`), checked for single-incident
 * binding (R29.1) and non-invalidation (R29.10). Any failure returns the
 * `410`-style "the safety check has concluded" body the portal renders (R29.11).
 *
 * READ-ONLY TRIAGE PAYLOAD (R29.6, R29.7). On a valid token `GET` returns the
 * Anchor preferred display name, society/building/flat, door-access
 * instructions + smart-lock backup codes, and a single-tap Primary Observer
 * dialer number. The response DTO (`ResponderTriagePayloadSchema`, `.strict()`)
 * STRUCTURALLY EXCLUDES location history, financial data, and chat history
 * (R29.7) — no such field is declared and `.strict()` rejects it appearing.
 *
 * DOSSIER RELEASE GATED ON STAGE-4 (R33.3). The decrypted-for-emergency
 * `Emergency_Medical_Dossier` is attached IFF the bound incident is at
 * STAGE_4_HYPERLOCAL_DISPATCH. Decryption is the deliberate break-glass escrow
 * boundary (design "Two Cryptographic Boundaries"): it happens server-side,
 * ONLY within a request serving a valid token for a Stage-4 incident, via the
 * injectable {@link DossierDecryptor} seam that holds the escrowed circle
 * emergency private key. Below Stage-4 (or with no stored dossier) the payload
 * simply omits `dossier`.
 *
 * VISIT AUDIT (R29.12). Every `GET` visit and `POST` click is appended to the
 * incident's `auditTrail` (ordered JSON array) with the source IP and
 * user-agent, preserving prior entries.
 *
 * CONFIRM → RESOLVE (R29.9, R29.10, R33.4). `POST .../confirm { responderName }`
 * records `resolutionSource = RESPONDER_CONFIRMED`, appends the confirm audit
 * entry, INVALIDATES the token (`invalidatedAt = now`, R29.10), REVOKES dossier
 * access (`accessState → EXPIRED`, R33.4), NOTIFIES all Circle Observers via the
 * injectable {@link ObserverNotifier} seam (R29.9), and emits `incident.resolved`
 * so the Sentinel worker performs the ATOMIC OPEN→RESOLVED transition + halts
 * pending stages (task 10.3, the single writer of the terminal status). The
 * route never flips `status` itself, so it never races the worker's conditional
 * update — mirroring `routes/incidents.ts`.
 *
 * Everything touching key material, the clock, or the outside world is behind an
 * injectable seam so the unit tests stay hermetic:
 *   - {@link EmergencyRouteDeps.verifyToken} — verifies signature + expiry and
 *     returns the claims (production: `app.jwt.verify`);
 *   - {@link EmergencyRouteDeps.hashToken} — recomputes the row lookup hash
 *     (must match the minter, `hashEmergencyToken`);
 *   - {@link EmergencyRouteDeps.decryptDossier} — break-glass dossier decrypt
 *     (production: the escrowed circle emergency key);
 *   - {@link EmergencyRouteDeps.notifyObservers} — Observer notification fan-out
 *     (R29.9);
 *   - {@link EmergencyRouteDeps.now} — injectable clock.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  EmergencyTokenParamSchema,
  ResponderConfirmSchema,
  ResponderTriagePayloadSchema,
  TokenConcludedSchema,
} from "@kshema/types";

import {
  EMERGENCY_TRIAGE_SCOPE,
  hashEmergencyToken,
  type EmergencyTokenClaims,
} from "../services/emergency-token.js";

/** Stage at which the Emergency_Medical_Dossier is released to responders (R33.3). */
const DOSSIER_RELEASE_STAGE = "STAGE_4_HYPERLOCAL_DISPATCH" as const;

/** Resolution source recorded when an on-scene responder confirms (R29.9). */
const RESPONDER_CONFIRMED = "RESPONDER_CONFIRMED" as const;

/** Dossier access state after revocation on resolution (R33.4). */
const DOSSIER_REVOKED_STATE = "EXPIRED" as const;

/** The "safety check has concluded" body for invalid/expired tokens (R29.11). */
const CONCLUDED_MESSAGE = "This safety check has concluded." as const;

/**
 * Verifies an emergency token's signature + expiry and returns its claims.
 * Production wiring closes over `@fastify/jwt`'s `app.jwt.verify`; tests pass a
 * deterministic fake. MUST throw on a bad signature or an expired token.
 */
export type EmergencyTokenVerifier = (rawToken: string) => EmergencyTokenClaims;

/** The encrypted dossier envelope columns loaded from the store (R33). */
export interface EncryptedDossierEnvelope {
  encryptedPayload: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedEmergencyKey: Buffer;
}

/** The decrypted-for-emergency dossier view (matches `EmergencyDossierViewSchema`). */
export interface DecryptedDossierView {
  bloodGroup?: string;
  allergies?: string[];
  chronicConditions?: string[];
  criticalMedications?: string[];
  attendingDoctorName?: string;
  attendingDoctorPhone?: string;
  healthInsurancePolicy?: string;
}

/**
 * Break-glass decrypt of an Emergency_Medical_Dossier envelope (R33.3). The
 * production implementation holds the escrowed circle emergency private key and
 * delegates to `@kshema/encryption/decrypt`'s `decryptEmergencyDossier`; tests
 * pass a fake. Invoked ONLY when a valid token binds a Stage-4 incident.
 */
export type DossierDecryptor = (
  envelope: EncryptedDossierEnvelope,
) => DecryptedDossierView;

/** Notifies all Circle Observers that a responder confirmed the Anchor safe (R29.9). */
export type ObserverNotifier = (input: {
  incidentId: string;
  circleId: string;
  anchorId: string;
  responderName: string;
}) => Promise<void>;

/** Dependencies injected into the emergency routes (replaceable in tests). */
export interface EmergencyRouteDeps {
  /** Verifies token signature + expiry, returns claims (prod: `app.jwt.verify`). */
  verifyToken: EmergencyTokenVerifier;
  /** Recomputes the row-lookup hash; defaults to the minter's SHA-256 hex. */
  hashToken?: (rawToken: string) => string;
  /** Break-glass dossier decryptor (prod: escrowed circle emergency key). */
  decryptDossier?: DossierDecryptor;
  /** Observer notification fan-out (R29.9). Defaults to a no-op if omitted. */
  notifyObservers?: ObserverNotifier;
  /** Injectable clock (epoch-ms); defaults to `Date.now`. */
  now?: () => number;
}

/** The verified-token context shared by both routes. */
interface VerifiedTokenContext {
  claims: EmergencyTokenClaims;
  tokenHash: string;
  row: {
    id: string;
    incidentId: string;
    scope: string;
    expiresAt: Date;
    invalidatedAt: Date | null;
  };
}

/** Extract a best-effort client IP + user-agent for the audit trail (R29.12). */
function auditContext(request: FastifyRequest): {
  ip: string;
  userAgent: string;
} {
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedIp =
    typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  const ip = forwardedIp || request.ip || "unknown";
  const ua = request.headers["user-agent"];
  const userAgent = (typeof ua === "string" && ua.length > 0 ? ua : "unknown");
  return { ip, userAgent };
}

export async function emergencyRoutes(
  app: FastifyInstance,
  deps: EmergencyRouteDeps,
): Promise<void> {
  const {
    verifyToken,
    hashToken = hashEmergencyToken,
    decryptDossier,
    notifyObservers,
    now = Date.now,
  } = deps;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Verify a presented raw token end-to-end (R29.10, R29.11):
   *   1. signature + expiry via the injected verifier (throws on failure);
   *   2. read-only triage scope on the claims;
   *   3. a persisted hash-only row matching hash(rawToken) exists;
   *   4. the row binds the SAME incident the claims name (R29.1);
   *   5. the row is not invalidated (R29.10) and not past `expiresAt` (R29.2).
   * Returns the verified context, or `null` when the token is invalid/expired —
   * the caller renders the "concluded" body (R29.11). Never distinguishes the
   * failure reason to the responder.
   */
  async function verify(rawToken: string): Promise<VerifiedTokenContext | null> {
    let claims: EmergencyTokenClaims;
    try {
      claims = verifyToken(rawToken);
    } catch {
      return null;
    }

    if (claims.scope !== EMERGENCY_TRIAGE_SCOPE || !claims.incidentId) {
      return null;
    }

    const tokenHash = hashToken(rawToken);
    const row = await app.prisma.emergencyAccessToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        incidentId: true,
        scope: true,
        expiresAt: true,
        invalidatedAt: true,
      },
    });
    if (!row) {
      return null;
    }

    // Single-incident binding: the row and the signed claims must name the same
    // incident (R29.1). A token minted for another incident is rejected.
    if (row.incidentId !== claims.incidentId) {
      return null;
    }

    // Non-invalidation (R29.10) and expiry (R29.2). The JWT `exp` is also
    // checked by `verifyToken`; we re-check the row's `expiresAt` so an
    // externally-cleared expiry cannot outlive the persisted window.
    if (row.invalidatedAt !== null) {
      return null;
    }
    if (row.expiresAt.getTime() <= now()) {
      return null;
    }

    return { claims, tokenHash, row };
  }

  // GET /emergency/:token — verify the token and return the read-only triage
  // payload. Includes the dossier IFF the bound incident is at Stage-4 (R33.3);
  // excludes location/financial/chat by construction (R29.7). Records the visit
  // with IP + user-agent (R29.12). Invalid/expired → 410 concluded (R29.11).
  typed.get(
    "/emergency/:token",
    {
      schema: {
        params: EmergencyTokenParamSchema,
        response: {
          200: ResponderTriagePayloadSchema,
          410: TokenConcludedSchema,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const concluded = () =>
        reply
          .code(410)
          .send({ concluded: true as const, message: CONCLUDED_MESSAGE });

      const ctx = await verify(token);
      if (!ctx) {
        return concluded();
      }

      // Load the bound incident. A missing incident is treated as concluded
      // (the token can no longer serve a triage view). Select ONLY the triage
      // and gating fields — never a location/financial/chat column (R29.7).
      const incident = await app.prisma.safetyIncident.findUnique({
        where: { id: ctx.row.incidentId },
        select: {
          id: true,
          circleId: true,
          anchorId: true,
          stage: true,
          status: true,
          auditTrail: true,
        },
      });
      if (!incident) {
        return concluded();
      }

      // Record the visit with source IP + user-agent (R29.12), preserving the
      // existing ordered trail.
      const { ip, userAgent } = auditContext(request);
      const existingTrail = Array.isArray(incident.auditTrail)
        ? incident.auditTrail
        : [];
      const visitEvent = {
        type: "RESPONDER_PORTAL_VISIT",
        at: new Date(now()).toISOString(),
        ip,
        userAgent,
      };
      await app.prisma.safetyIncident.update({
        where: { id: incident.id },
        data: { auditTrail: [...existingTrail, visitEvent] },
      });

      // Anchor preferred display name (R29.6) + hyperlocal triage attributes.
      const [anchor, profile] = await Promise.all([
        app.prisma.user.findUnique({
          where: { id: incident.anchorId },
          select: { preferredName: true },
        }),
        app.prisma.hyperlocalContactProfile.findUnique({
          where: { anchorId: incident.anchorId },
          select: {
            society: true,
            building: true,
            flat: true,
            doorAccess: true,
            primaryObserverPhone: true,
          },
        }),
      ]);

      // Dossier release gated on Stage-4 (R33.3). Only decrypt within THIS
      // valid-token, Stage-4 request; below Stage-4 the field is simply absent.
      let dossier: DecryptedDossierView | undefined;
      if (incident.stage === DOSSIER_RELEASE_STAGE && decryptDossier) {
        const record = await app.prisma.emergencyMedicalDossier.findUnique({
          where: { userId: incident.anchorId },
          select: {
            encryptedPayload: true,
            iv: true,
            authTag: true,
            encryptedEmergencyKey: true,
          },
        });
        if (record) {
          dossier = decryptDossier({
            encryptedPayload: record.encryptedPayload,
            iv: record.iv,
            authTag: record.authTag,
            encryptedEmergencyKey: record.encryptedEmergencyKey,
          });
        }
      }

      // Normalize the array fields the response DTO requires (they default to
      // `[]`), so a decrypted dossier that omitted them still serializes cleanly.
      const dossierView = dossier
        ? {
            ...(dossier.bloodGroup ? { bloodGroup: dossier.bloodGroup } : {}),
            allergies: dossier.allergies ?? [],
            chronicConditions: dossier.chronicConditions ?? [],
            criticalMedications: dossier.criticalMedications ?? [],
            ...(dossier.attendingDoctorName
              ? { attendingDoctorName: dossier.attendingDoctorName }
              : {}),
            ...(dossier.attendingDoctorPhone
              ? { attendingDoctorPhone: dossier.attendingDoctorPhone }
              : {}),
            ...(dossier.healthInsurancePolicy
              ? { healthInsurancePolicy: dossier.healthInsurancePolicy }
              : {}),
          }
        : undefined;

      // Build the strict triage payload. `.strict()` on the response DTO forbids
      // any location/financial/chat field appearing (R29.7).
      return {
        preferredName: anchor?.preferredName ?? "Resident",
        ...(profile?.society ? { society: profile.society } : {}),
        ...(profile?.building ? { building: profile.building } : {}),
        ...(profile?.flat ? { flat: profile.flat } : {}),
        ...(profile?.doorAccess
          ? { doorAccessInstructions: profile.doorAccess }
          : {}),
        // No dedicated smart-lock-codes column exists yet; default to none.
        smartLockBackupCodes: [],
        ...(profile?.primaryObserverPhone
          ? { primaryObserverDialer: profile.primaryObserverPhone }
          : {}),
        incidentStage: incident.stage,
        ...(dossierView ? { dossier: dossierView } : {}),
      };
    },
  );

  // POST /emergency/:token/confirm — a responder confirms the Anchor is safe.
  // Records RESPONDER_CONFIRMED, invalidates the token (R29.10), revokes dossier
  // access (R33.4), notifies Observers (R29.9), logs the click (R29.12), and
  // emits `incident.resolved` for the worker's atomic transition (R29.9).
  // Invalid/expired → 410 concluded (R29.11).
  typed.post(
    "/emergency/:token/confirm",
    {
      schema: {
        params: EmergencyTokenParamSchema,
        body: ResponderConfirmSchema,
        response: {
          200: TokenConcludedSchema,
          410: TokenConcludedSchema,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const { responderName } = request.body;
      const concluded = () =>
        reply
          .code(410)
          .send({ concluded: true as const, message: CONCLUDED_MESSAGE });

      const ctx = await verify(token);
      if (!ctx) {
        return concluded();
      }

      const incident = await app.prisma.safetyIncident.findUnique({
        where: { id: ctx.row.incidentId },
        select: {
          id: true,
          circleId: true,
          anchorId: true,
          auditTrail: true,
        },
      });
      if (!incident) {
        return concluded();
      }

      const nowMs = now();
      const nowDate = new Date(nowMs);

      // Log the confirm click with IP + user-agent (R29.12) and record the
      // request-side resolution source, preserving the ordered trail. The worker
      // owns the terminal OPEN→RESOLVED transition (task 10.3), so we do not flip
      // `status` here and never race its conditional update — mirroring
      // routes/incidents.ts.
      const { ip, userAgent } = auditContext(request);
      const existingTrail = Array.isArray(incident.auditTrail)
        ? incident.auditTrail
        : [];
      const confirmEvent = {
        type: "RESPONDER_CONFIRMED",
        at: nowDate.toISOString(),
        ip,
        userAgent,
        responderName,
        source: RESPONDER_CONFIRMED,
      };
      await app.prisma.safetyIncident.update({
        where: { id: incident.id },
        data: {
          resolutionSource: RESPONDER_CONFIRMED,
          auditTrail: [...existingTrail, confirmEvent],
        },
      });

      // Invalidate the token immediately (R29.10) and revoke dossier access
      // (R33.4). Both are keyed on the incident so any later portal request for
      // this incident renders the "concluded" body.
      await app.prisma.emergencyAccessToken.update({
        where: { id: ctx.row.id },
        data: { invalidatedAt: nowDate },
      });
      await app.prisma.emergencyMedicalDossier.updateMany({
        where: { userId: incident.anchorId },
        data: { accessState: DOSSIER_REVOKED_STATE },
      });

      // Notify all Circle Observers the Anchor is confirmed safe (R29.9).
      if (notifyObservers) {
        await notifyObservers({
          incidentId: incident.id,
          circleId: incident.circleId,
          anchorId: incident.anchorId,
          responderName,
        });
      }

      // Emit for the worker to perform the atomic transition + stage halt
      // (R29.9; worker task 10.3 is the single writer of the terminal status).
      await app.events.emit("incident.resolved", {
        incidentId: incident.id,
        source: RESPONDER_CONFIRMED,
      });

      return {
        concluded: true as const,
        message: "Thank you. The Circle has been notified the resident is safe.",
      };
    },
  );
}

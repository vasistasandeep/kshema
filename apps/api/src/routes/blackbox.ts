/**
 * Zero-knowledge black-box sync route (task 6.1 — R8.4, R8.5, R8.6, R19.3).
 *
 * Mounted under `/api/v1`, so the effective path is:
 *   - `POST /api/v1/telemetry/blackbox-sync`  store an Encrypted_Black_Box verbatim
 *
 * SERVER-BLIND BY CONSTRUCTION (R8.6, R19.3). This module stores the encrypted
 * Flight_Recorder envelope exactly as the Anchor's device produced it and NEVER
 * decrypts, inspects, or transforms the plaintext. It deliberately imports NO
 * decrypt capability: `@kshema/encryption`'s entrypoint does not re-export
 * `decryptBlackBox`, and nothing here reaches for `@kshema/encryption/decrypt`.
 * The only key material that transits is the symmetric payload key already
 * RSA-OAEP fan-out-wrapped once per authorized Observer (R8.5) — the server
 * holds no private key and so can never unwrap it.
 *
 * Authenticated (`app.authenticate`). The bearer identifies the Anchor whose
 * on-device Flight_Recorder produced this envelope; `anchorId` is taken from
 * `request.user.sub` (the request body carries no `anchorId`, so a caller can
 * only sync its own black box). `circleId` and the per-Observer `recipientKeys`
 * come from the body (`BlackBoxSyncSchema` in `@kshema/types`, `.strict()`).
 *
 * PERSISTENCE. One `EncryptedBlackBox` row stores the ciphertext, IV, and GCM
 * auth tag as `Bytes`, plus one `BlackBoxRecipientKey` row per wrapped Observer
 * key (respecting `@@unique([boxId, observerId])`). The ciphertext is decoded
 * from base64 to a `Buffer` for the `Bytes` columns and stored VERBATIM — the
 * round trip base64 -> Buffer -> base64 is byte-for-byte lossless, and the
 * plaintext is never materialized. `released` stays at its schema default
 * (`false`); the gated release lives in task 6.2.
 *
 * IDEMPOTENCY. `EncryptedBlackBox` has no natural key (no client-supplied box
 * id, device id, or unique constraint on the captured range), so a re-sent
 * logical box cannot be safely deduplicated at this layer without risking
 * collapsing two genuinely distinct 15-minute snapshots. We therefore CREATE a
 * fresh box per request. The buffer is a bounded ring (≤20 snapshots / ≤60
 * minutes, R8.2) synced on a 15-minute cadence (R8.4), so duplicate boxes are
 * self-limiting and harmless; the release/fetch layer (task 6.2) selects the
 * relevant box(es) by incident. A future migration adding a client box id +
 * unique constraint could move this to an upsert.
 *
 * ---------------------------------------------------------------------------
 * AUTHORIZED FETCH (task 6.2 — R8.7, R8.8, R9.3, R19.6). Mounted alongside the
 * sync route, the effective path is:
 *   - `POST /api/v1/incidents/:id/blackbox`  fetch the released ciphertext
 *
 * Grant iff (a) the caller is a `CircleMember` of the incident's circle holding
 * `canAccessBlackBox = true` (R8.8 "Observers holding the access permission"),
 * AND (b) the black box has been RELEASED — released iff the incident reached
 * STAGE_4_HYPERLOCAL_DISPATCH or is HANDED_OFF_SOS/Shadow_SOS (R8.7/8.8, R9.3).
 * Any other case denies with `403` (authorization error). Unknown incident or
 * no matching released box -> `404`; a box exists but carries no wrapped key for
 * this observer -> `403`.
 *
 * STILL SERVER-BLIND (R8.6, R19.3). On grant the API returns ciphertext ONLY —
 * the shared `encryptedPayload`/`iv`/`authTag` plus the ONE
 * `BlackBoxRecipientKey.wrappedKey` fan-out-wrapped to the requesting Observer.
 * The Observer unwraps and decrypts on-device / in the Web_Crypto_Vault (R8.9,
 * R28.3). This module imports NO decrypt capability.
 *
 * BOX <-> INCIDENT ASSOCIATION. `EncryptedBlackBox` carries `circleId`,
 * `anchorId`, and a `capturedRange` but NO direct `incidentId` FK. We therefore
 * associate a box with an incident by matching BOTH `circleId` AND `anchorId`
 * (a `SafetyIncident` records both), scoped to boxes with `released = true`,
 * and select the most recently captured such box (`capturedRangeEnd` desc, then
 * `createdAt` desc) — the freshest rolling snapshot for that Anchor's circle at
 * the time of escalation. ASSUMPTION: the incident's Anchor is the subject of
 * the released Flight_Recorder buffer; because the sync route CREATEs a fresh
 * box per 15-minute cadence, "most recent released box for this anchor+circle"
 * is the buffer relevant to the active incident. A future migration adding an
 * `incidentId` FK (or captured-range ⊇ incident-open-time selection) would make
 * this exact rather than heuristic.
 *
 * AUDIT (R19.6). Every grant appends an access event
 * `{ type: "BLACK_BOX_ACCESS", observerId, boxId, at }` to the incident's
 * `auditTrail` (an ordered JSON array), preserving the existing entries.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  BlackBoxSyncSchema,
  BlackBoxSyncResponseSchema,
  BlackBoxCiphertextSchema,
} from "@kshema/types";

/**
 * Incident statuses/stages at which the Encrypted_Black_Box is RELEASED
 * (R8.7/8.8, R9.3): a Stage-4 Hyperlocal_Dispatch incident, or a Shadow_SOS
 * handed-off incident. Anything else keeps the gate closed.
 */
const RELEASED_STAGE = "STAGE_4_HYPERLOCAL_DISPATCH" as const;
const RELEASED_STATUS = "HANDED_OFF_SOS" as const;

/** Descriptive `403` envelope for the authorization-denial paths. */
const BlackBoxForbiddenSchema = z
  .object({
    error: z.literal("Forbidden"),
    message: z.string(),
  })
  .strict();

/** Descriptive `404` envelope for an unknown incident / no released box. */
const BlackBoxNotFoundSchema = z
  .object({
    error: z.literal("Not Found"),
    message: z.string(),
  })
  .strict();

export async function blackboxRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /telemetry/blackbox-sync — persist an Encrypted_Black_Box envelope and
  // its fan-out-wrapped Observer keys verbatim; perform no decryption (R8.4,
  // R8.5, R8.6, R19.3).
  typed.post(
    "/telemetry/blackbox-sync",
    {
      onRequest: [app.authenticate],
      schema: {
        body: BlackBoxSyncSchema,
        response: { 200: BlackBoxSyncResponseSchema },
      },
    },
    async (request) => {
      const anchorId = request.user.sub;
      const { circleId, encryptedPayload, iv, authTag, recipientKeys, capturedRange } =
        request.body;

      // Decode the base64 ciphertext fields to Bytes. This is a pure transport
      // decode — the resulting buffers are stored verbatim and NEVER decrypted
      // or inspected (R8.6, R19.3).
      const box = await app.prisma.encryptedBlackBox.create({
        data: {
          circleId,
          anchorId,
          encryptedPayload: Buffer.from(encryptedPayload, "base64"),
          iv: Buffer.from(iv, "base64"),
          authTag: Buffer.from(authTag, "base64"),
          capturedRangeStart: new Date(capturedRange.start),
          capturedRangeEnd: new Date(capturedRange.end),
          // `released` intentionally omitted — defaults to false (R8.7/8.8).
          recipientKeys: {
            create: recipientKeys.map((rk) => ({
              observerId: rk.observerId,
              wrappedKey: Buffer.from(rk.wrappedKey, "base64"),
            })),
          },
        },
        select: { id: true },
      });

      return { boxId: box.id, storedRecipients: recipientKeys.length };
    },
  );

  // POST /incidents/:id/blackbox — authorized fetch of the released
  // Encrypted_Black_Box ciphertext for the requesting Observer. Gated on
  // `canAccessBlackBox` AND box release (Stage-4 or Shadow_SOS); returns
  // ciphertext ONLY and appends an access event to the incident audit trail.
  // No decryption anywhere (R8.7, R8.8, R9.3, R19.6, R8.6/R19.3).
  typed.post(
    "/incidents/:id/blackbox",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        response: {
          200: BlackBoxCiphertextSchema,
          403: BlackBoxForbiddenSchema,
          404: BlackBoxNotFoundSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: incidentId } = request.params;
      const observerId = request.user.sub;

      const forbidden = (message: string) =>
        reply.code(403).send({ error: "Forbidden" as const, message });
      const notFound = (message: string) =>
        reply.code(404).send({ error: "Not Found" as const, message });

      // 1) The incident must exist. Unknown id -> 404 (no data to release).
      const incident = await app.prisma.safetyIncident.findUnique({
        where: { id: incidentId },
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
        return notFound("No such incident.");
      }

      // 2) The caller must be a CircleMember of the incident's circle who holds
      //    the Encrypted_Black_Box access permission (R8.8). A non-member, or a
      //    member without `canAccessBlackBox`, is denied identically (403) so we
      //    never leak whether the caller is in the circle at all.
      const membership = await app.prisma.circleMember.findFirst({
        where: { circleId: incident.circleId, userId: observerId },
        select: { canAccessBlackBox: true },
      });
      if (!membership || !membership.canAccessBlackBox) {
        return forbidden(
          "You are not authorized to access the black box for this incident.",
        );
      }

      // 3) The black box is RELEASED only once the incident reaches Stage-4
      //    Hyperlocal_Dispatch or is handed off to Shadow_SOS (R8.7, R8.8,
      //    R9.3). Otherwise the gate stays closed regardless of permission.
      const released =
        incident.stage === RELEASED_STAGE || incident.status === RELEASED_STATUS;
      if (!released) {
        return forbidden(
          "The black box for this incident has not been released.",
        );
      }

      // 4) Locate the released box for this incident. Association is by
      //    circle + anchor (see module header), scoped to released boxes, taking
      //    the most recently captured one.
      const box = await app.prisma.encryptedBlackBox.findFirst({
        where: {
          circleId: incident.circleId,
          anchorId: incident.anchorId,
          released: true,
        },
        orderBy: [{ capturedRangeEnd: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          encryptedPayload: true,
          iv: true,
          authTag: true,
          capturedRangeStart: true,
          capturedRangeEnd: true,
          recipientKeys: {
            where: { observerId },
            select: { wrappedKey: true },
          },
        },
      });
      if (!box) {
        return notFound("No released black box is available for this incident.");
      }

      // 5) The box must carry a key fan-out-wrapped to THIS Observer. Absent one,
      //    the caller cannot decrypt it and is denied (403) — the server holds no
      //    private key and never unwraps or substitutes another Observer's key.
      const recipientKey = box.recipientKeys[0];
      if (!recipientKey) {
        return forbidden(
          "No black-box key is wrapped for you on this incident.",
        );
      }

      // 6) Record the access in the incident audit trail (R19.6). Preserve the
      //    existing ordered entries and append the access event.
      const existingTrail = Array.isArray(incident.auditTrail)
        ? incident.auditTrail
        : [];
      const accessEvent = {
        type: "BLACK_BOX_ACCESS",
        observerId,
        boxId: box.id,
        at: new Date().toISOString(),
      };
      await app.prisma.safetyIncident.update({
        where: { id: incident.id },
        data: { auditTrail: [...existingTrail, accessEvent] },
      });

      // 7) Return ciphertext ONLY (R8.6, R19.3) — the shared encrypted payload
      //    plus the single wrapped key for this Observer, base64-encoded for
      //    transport. Decryption happens on the Observer's device (R8.9, R28.3).
      return {
        boxId: box.id,
        encryptedPayload: box.encryptedPayload.toString("base64"),
        iv: box.iv.toString("base64"),
        authTag: box.authTag.toString("base64"),
        wrappedKey: recipientKey.wrappedKey.toString("base64"),
        capturedRange: {
          start: box.capturedRangeStart.toISOString(),
          end: box.capturedRangeEnd.toISOString(),
        },
      };
    },
  );
}

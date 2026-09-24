/**
 * @kshema/types — shared primitives and privacy invariants.
 *
 * Privacy posture enforced structurally by the DTOs in this package:
 *   * Requests accept ONLY public-key material (`clientPublicKeyPem` /
 *     `observerPublicKeyPem`). No request DTO carries a private key — the
 *     private key is structurally excluded from transmission (R1.8, R28.2).
 *   * No request/response DTO carries a continuous location trace (R5.5,
 *     R15.5, R19.1).
 *   * Responder / dashboard DTOs additionally exclude financial and chat
 *     fields (R29.7).
 */
import { z } from "zod";

/** Non-empty trimmed string. */
export const NonEmptyString = z.string().trim().min(1);

/** ISO-8601 datetime string (used across telemetry / incident payloads). */
export const IsoDateTime = z.string().datetime({ offset: true });

/** E.164-style phone number. */
export const PhoneNumber = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/, "must be an E.164-style phone number");

/** IANA timezone identifier (e.g. "Asia/Kolkata"). */
export const Timezone = NonEmptyString;

/** cuid-style identifier issued by Prisma. */
export const Id = NonEmptyString;

/**
 * A PEM-encoded PUBLIC key. This is the ONLY key material a request DTO may
 * carry. Requests never accept a private key (R1.8, R28.2).
 */
export const PublicKeyPem = z
  .string()
  .trim()
  .regex(
    /-----BEGIN (?:RSA )?PUBLIC KEY-----/,
    "must be a PEM-encoded PUBLIC key (private keys never transit)",
  );

/** Base64 payload (used for ciphertext blobs the server stores verbatim). */
export const Base64 = z.string().trim().min(1);

/**
 * Fields that must NEVER appear on a request DTO. Used by the private-key
 * absence contract test (task 3.3) and as documentation of the invariant.
 */
export const FORBIDDEN_REQUEST_KEY_FIELDS = [
  "privateKey",
  "privateKeyPem",
  "clientPrivateKey",
  "clientPrivateKeyPem",
  "observerPrivateKey",
  "observerPrivateKeyPem",
  "secretKey",
] as const;

/**
 * Fields that must NEVER appear on a responder/dashboard response DTO.
 * Continuous location traces are excluded everywhere; financial and chat
 * data are additionally excluded from responder/dashboard surfaces
 * (R5.5, R15.5, R19.1, R29.7).
 */
export const FORBIDDEN_RESPONDER_FIELDS = [
  "location",
  "locationTrace",
  "locationHistory",
  "gps",
  "coordinates",
  "latitude",
  "longitude",
  "breadcrumbs",
  "financial",
  "payment",
  "chat",
  "messages",
  "chatHistory",
] as const;

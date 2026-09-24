/**
 * @kshema/types — shared DTOs and Zod schemas (task 1.4).
 *
 * One source of truth for request/response validation across `apps/api`,
 * `apps/mobile`, `apps/admin`, and `apps/web`.
 *
 * Privacy invariants enforced structurally by these schemas:
 *   * Requests accept ONLY public-key material (`clientPublicKeyPem` /
 *     `observerPublicKeyPem`). No request DTO carries a private key, so the
 *     private key is structurally excluded from transmission (R1.8, R28.2).
 *   * No DTO carries a continuous location trace (R5.5, R15.5, R19.1).
 *   * Responder/dashboard DTOs additionally exclude financial and chat data
 *     (R29.7).
 * Every object schema uses `.strict()`, so an unexpected (e.g. private-key or
 * location) field is rejected rather than silently accepted.
 */
export const TYPES_PACKAGE = "@kshema/types" as const;

export * from "./common.js";
export * from "./enums.js";
export * from "./auth.js";
export * from "./circles.js";
export * from "./telemetry.js";
export * from "./blackbox.js";
export * from "./incidents.js";
export * from "./vitality.js";
export * from "./sanctuary.js";
export * from "./dossier.js";
export * from "./observer.js";
export * from "./subscriptions.js";
export * from "./admin.js";
export * from "./web.js";
export * from "./data-safety.js";

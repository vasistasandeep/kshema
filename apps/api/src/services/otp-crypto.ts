/**
 * OTP generation and hashing primitives (R1.1, R1.3).
 *
 * The plaintext OTP is NEVER persisted: only a salted HMAC-SHA-256 digest is
 * stored, so a leak of the challenge store cannot reveal live codes. Digests
 * are compared in constant time to avoid a timing side-channel on verification.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Default OTP length (digits). */
export const OTP_LENGTH = 6;

/**
 * Generate a numeric OTP of the given length using a cryptographically strong
 * RNG. Leading zeros are preserved (padded), so every code is exactly `length`
 * digits.
 */
export function generateOtp(length: number = OTP_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

/** A random per-challenge salt, hex-encoded. */
export function generateOtpSalt(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Hash an OTP with a salt and a server-side secret (HMAC-SHA-256). The secret
 * binds the digest to this deployment so a stolen store row is useless without
 * it. Returns a hex digest.
 */
export function hashOtp(code: string, salt: string, secret: string): string {
  return createHmac("sha256", secret).update(`${salt}:${code}`).digest("hex");
}

/**
 * Constant-time comparison of a candidate code against a stored digest.
 * Returns false on any length/format mismatch without leaking timing.
 */
export function verifyOtp(
  candidate: string,
  salt: string,
  secret: string,
  storedHash: string,
): boolean {
  const candidateHash = hashOtp(candidate, salt, secret);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}

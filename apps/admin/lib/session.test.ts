/**
 * Unit tests for the admin token decode (R21.1).
 *
 * `decodeAdminToken` is advisory-only UI gating — it extracts the admin id,
 * single role, and MFA claim for hide/disable decisions. The server remains
 * authoritative on signature + MFA. These tests assert the decode is robust to
 * malformed/expired tokens and honours the MFA claim.
 */
import { describe, expect, it } from "vitest";
import { decodeAdminToken } from "./session";

/** Build a JWT with a base64url-encoded payload (signature is not verified here). */
function makeToken(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

describe("decodeAdminToken (R21.1)", () => {
  it("decodes a valid MFA admin token into an advisory session", () => {
    const token = makeToken({ sub: "admin_1", adminRole: "SUPER_ADMIN", mfa: true });
    const session = decodeAdminToken(token);
    expect(session).toEqual({
      token,
      adminUserId: "admin_1",
      role: "SUPER_ADMIN",
      mfa: true,
    });
  });

  it("reports mfa:false when the MFA claim is absent (console refuses entry)", () => {
    const token = makeToken({ sub: "admin_2", adminRole: "SUPPORT_AGENT" });
    expect(decodeAdminToken(token)?.mfa).toBe(false);
  });

  it("tolerates a leading Bearer prefix", () => {
    const token = makeToken({ sub: "admin_3", adminRole: "BILLING_OPS", mfa: true });
    const session = decodeAdminToken(`Bearer ${token}`);
    expect(session?.role).toBe("BILLING_OPS");
    // The stored token strips the Bearer prefix.
    expect(session?.token).toBe(token);
  });

  it("rejects a token carrying an unknown role", () => {
    const token = makeToken({ sub: "admin_4", adminRole: "ROOT", mfa: true });
    expect(decodeAdminToken(token)).toBeNull();
  });

  it("rejects a token with no subject", () => {
    const token = makeToken({ adminRole: "SUPER_ADMIN", mfa: true });
    expect(decodeAdminToken(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = 1_000_000_000_000;
    const token = makeToken({
      sub: "admin_5",
      adminRole: "SUPER_ADMIN",
      mfa: true,
      exp: Math.floor(now / 1000) - 60, // expired a minute ago
    });
    expect(decodeAdminToken(token, now)).toBeNull();
  });

  it("accepts a not-yet-expired token", () => {
    const now = 1_000_000_000_000;
    const token = makeToken({
      sub: "admin_6",
      adminRole: "SUPPORT_AGENT",
      mfa: true,
      exp: Math.floor(now / 1000) + 3600,
    });
    expect(decodeAdminToken(token, now)?.adminUserId).toBe("admin_6");
  });

  it("rejects a structurally malformed token", () => {
    expect(decodeAdminToken("not-a-jwt")).toBeNull();
    expect(decodeAdminToken("only.two")).toBeNull();
    expect(decodeAdminToken("")).toBeNull();
  });
});

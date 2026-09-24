/**
 * Web authentication DTO contract + responder-portal render-budget tests
 * (R28.2, R29.5, task 25.4).
 *
 * The Web_Crypto_Vault hands the API ONLY the public PEM (R28.2). This asserts
 * that contract structurally at the web boundary: the `WebOtpVerify` schema
 * accepts a `clientPublicKeyPem` and — because every web DTO is `.strict()` —
 * rejects any request that smuggles a private key or a location field. It also
 * pins the ephemeral responder portal's inlined critical CSS to the brand
 * palette (no clinical red / hospital blue) and keeps it small enough to make
 * the <1.5s-on-3G first render budget (R29.5).
 */
import { describe, expect, it } from "vitest";
import {
  WebOtpVerifySchema,
  WebAuthnAuthenticateVerifySchema,
} from "@kshema/types";
import { palette } from "@kshema/ui";
import { CRITICAL_CSS } from "../app/emergency/[token]/critical-css";

const VALID_PUBLIC_PEM =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n" +
  "-----END PUBLIC KEY-----\n";

describe("Web OTP verify DTO — private-key absence (R28.2)", () => {
  it("accepts a request carrying only the vault PUBLIC pem", () => {
    const parsed = WebOtpVerifySchema.safeParse({
      challengeId: "chal-1",
      code: "123456",
      clientPublicKeyPem: VALID_PUBLIC_PEM,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a request that smuggles a private key field (.strict)", () => {
    const parsed = WebOtpVerifySchema.safeParse({
      challengeId: "chal-1",
      code: "123456",
      clientPublicKeyPem: VALID_PUBLIC_PEM,
      clientPrivateKeyPem:
        "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a private PEM supplied in place of the public key", () => {
    const parsed = WebOtpVerifySchema.safeParse({
      challengeId: "chal-1",
      code: "123456",
      clientPublicKeyPem:
        "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
    });
    expect(parsed.success).toBe(false);
  });

  it("declares no field whose name suggests a private key", () => {
    const shape = (WebOtpVerifySchema as unknown as { shape: Record<string, unknown> })
      .shape;
    for (const key of Object.keys(shape)) {
      expect(key.toLowerCase()).not.toContain("private");
    }
  });
});

describe("WebAuthn assertion DTO — no secret material (R28.1)", () => {
  it("rejects an assertion that adds an unexpected private-key field", () => {
    const parsed = WebAuthnAuthenticateVerifySchema.safeParse({
      credentialId: "cred-1",
      signature: "AA==",
      authenticatorData: "AA==",
      clientDataJSON: "e30=",
      counter: 1,
      privateKey: "AA==",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Responder portal critical CSS — brand + render budget (R29.5)", () => {
  it("draws from the brand palette and never uses clinical red / hospital blue", () => {
    expect(CRITICAL_CSS).toContain(palette.sandalwoodCream);
    expect(CRITICAL_CSS).toContain(palette.terracotta);
    expect(CRITICAL_CSS.toUpperCase()).not.toContain("#FF0000");
    expect(CRITICAL_CSS.toUpperCase()).not.toContain("#0066FF");
  });

  it("is small enough to inline for a <1.5s 3G first render", () => {
    const bytes = Buffer.byteLength(CRITICAL_CSS, "utf8");
    // Inlined critical CSS must stay tiny (well under a single 3G TCP window's
    // worth of head payload). 8KB is a generous ceiling.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(8 * 1024);
  });

  it("provides large tap targets for outdoor / locked-phone responders", () => {
    // 56px minimum button height keeps the single-tap confirm reachable.
    expect(CRITICAL_CSS).toMatch(/min-height:56px/);
  });
});

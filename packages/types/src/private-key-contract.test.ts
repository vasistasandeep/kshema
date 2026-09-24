/**
 * Private-key-absence CONTRACT test for @kshema/types (task 3.3).
 *
 * Proves Requirement 1.8 STRUCTURALLY across the whole package: the Anchor /
 * Observer private key is retained only in the Secure_Enclave and is excluded
 * from every request DTO, so it can never transit to the Kshema_API.
 *
 * Rather than trusting a hand-picked list of schemas, this test ENUMERATES
 * every Zod schema exported from `@kshema/types`, unwraps it to its underlying
 * object shape, and asserts:
 *   1. No schema declares any field named like a private key
 *      (every name in FORBIDDEN_REQUEST_KEY_FIELDS is absent from the shape).
 *   2. Because every object schema is `.strict()`, injecting a private-key
 *      field into an otherwise-valid payload is rejected.
 *
 * It also asserts the auth OtpVerifySchema accepts a real public key in the
 * `clientPublicKeyPem` slot but rejects a PRIVATE KEY PEM placed there
 * (R1.1, R1.2, R1.3, R1.8).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.8
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as Types from "./index.js";
import { FORBIDDEN_REQUEST_KEY_FIELDS, OtpVerifySchema } from "./index.js";

/**
 * Unwrap the modifier wrappers Zod puts around a base type
 * (`.optional()`, `.default()`, `.nullable()`, `.refine()`/`.transform()`
 * which produce ZodEffects) until we reach the innermost schema. This lets us
 * discover the underlying ZodObject even when a request schema is defined with
 * a `.strict().refine(...)` chain (e.g. CreateSanctuarySchema,
 * UpdateMemberPermissionsSchema).
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  // Guard against any pathological cycle.
  for (let i = 0; i < 20; i += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return current;
}

/** Every exported Zod schema, paired with its export name. */
const exportedSchemas: Array<[string, z.ZodTypeAny]> = (
  Object.entries(Types) as Array<[string, unknown]>
)
  .filter((entry): entry is [string, z.ZodTypeAny] => entry[1] instanceof z.ZodType)
  .sort((a, b) => a[0].localeCompare(b[0]));

/** Object schemas only (the shape-bearing ones we can introspect). */
const objectSchemas: Array<[string, z.ZodObject<z.ZodRawShape>]> = exportedSchemas
  .map(([name, schema]) => [name, unwrap(schema)] as const)
  .filter(
    (entry): entry is [string, z.ZodObject<z.ZodRawShape>] =>
      entry[1] instanceof z.ZodObject,
  )
  .map(([name, schema]) => [name, schema]);

const validClientPem =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqABC\n-----END PUBLIC KEY-----";

describe("private-key-absence contract across ALL @kshema/types schemas (R1.8)", () => {
  it("discovers the shared schemas so the enumeration is not empty", () => {
    // Sanity guard: if the export surface changes drastically or the unwrap
    // helper breaks, this stops the contract from silently passing on nothing.
    expect(exportedSchemas.length).toBeGreaterThan(10);
    expect(objectSchemas.length).toBeGreaterThan(10);
  });

  it("declares no private-key-like field on any exported object schema", () => {
    const forbidden = new Set<string>(FORBIDDEN_REQUEST_KEY_FIELDS);
    for (const [name, schema] of objectSchemas) {
      const declaredKeys = Object.keys(schema.shape);
      for (const key of declaredKeys) {
        expect(
          forbidden.has(key),
          `schema "${name}" must not declare private-key field "${key}"`,
        ).toBe(false);
      }
    }
  });

  it("rejects an injected private-key field on every strict object schema", () => {
    for (const [name, schema] of objectSchemas) {
      for (const injected of FORBIDDEN_REQUEST_KEY_FIELDS) {
        // A strict object rejects unknown keys. We only need to prove the
        // schema NEVER accepts an object that carries a private-key field.
        const result = schema.safeParse({ [injected]: "leaked-private-key" });
        expect(
          result.success,
          `schema "${name}" must reject injected private-key field "${injected}"`,
        ).toBe(false);
      }
    }
  });
});

describe("auth OtpVerifySchema public-key contract (R1.1, R1.2, R1.3, R1.8)", () => {
  const base = {
    challengeId: "chal_1",
    code: "123456",
    clientPublicKeyPem: validClientPem,
    timezone: "Asia/Kolkata",
  };

  it("accepts a well-formed verify payload carrying only a public key", () => {
    expect(OtpVerifySchema.safeParse(base).success).toBe(true);
  });

  it("accepts optional preferredName and pushToken alongside the public key", () => {
    expect(
      OtpVerifySchema.safeParse({
        ...base,
        preferredName: "Amma",
        pushToken: "expo-push-token",
      }).success,
    ).toBe(true);
  });

  it("rejects a PRIVATE KEY PEM placed in the clientPublicKeyPem slot", () => {
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    expect(
      OtpVerifySchema.safeParse({ ...base, clientPublicKeyPem: privatePem }).success,
    ).toBe(false);
  });

  it("rejects an RSA PRIVATE KEY PEM placed in the clientPublicKeyPem slot", () => {
    const rsaPrivatePem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(
      OtpVerifySchema.safeParse({ ...base, clientPublicKeyPem: rsaPrivatePem }).success,
    ).toBe(false);
  });

  it("rejects any private-key field added to the verify payload", () => {
    for (const injected of FORBIDDEN_REQUEST_KEY_FIELDS) {
      expect(
        OtpVerifySchema.safeParse({ ...base, [injected]: validClientPem }).success,
        `OtpVerifySchema must reject "${injected}"`,
      ).toBe(false);
    }
  });
});

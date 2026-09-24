/**
 * Privacy-invariant contract tests for @kshema/types.
 *
 * These assert the structural exclusions the whole platform depends on:
 *   * No request DTO accepts a private-key field (R1.8, R28.2).
 *   * No responder/dashboard DTO accepts a location/financial/chat field
 *     (R5.5, R15.5, R19.1, R29.7).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FORBIDDEN_REQUEST_KEY_FIELDS,
  FORBIDDEN_RESPONDER_FIELDS,
  OtpVerifySchema,
  WebOtpVerifySchema,
  JoinCircleSchema,
  UpsertMedicalDossierSchema,
  ResponderTriagePayloadSchema,
  ObserverDashboardSchema,
  AnchorWellBeingSchema,
} from "./index.js";

const validClientPem =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqABC\n-----END PUBLIC KEY-----";

/** Every request DTO that carries public-key material. */
const requestSchemasAcceptingKeys: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
  [
    "OtpVerifySchema",
    OtpVerifySchema,
    {
      challengeId: "chal_1",
      code: "123456",
      clientPublicKeyPem: validClientPem,
      timezone: "Asia/Kolkata",
    },
  ],
  [
    "WebOtpVerifySchema",
    WebOtpVerifySchema,
    { challengeId: "chal_1", code: "123456", clientPublicKeyPem: validClientPem },
  ],
  [
    "JoinCircleSchema",
    JoinCircleSchema,
    { inviteToken: "tok_1", role: "OBSERVER", observerPublicKeyPem: validClientPem },
  ],
];

describe("private-key absence contract (R1.8, R28.2)", () => {
  it("accepts a well-formed request carrying only a public key", () => {
    for (const [name, schema, base] of requestSchemasAcceptingKeys) {
      expect(schema.safeParse(base).success, `${name} should accept a valid public-key payload`).toBe(
        true,
      );
    }
  });

  it("rejects any private-key field on every key-bearing request DTO", () => {
    for (const [name, schema, base] of requestSchemasAcceptingKeys) {
      for (const forbidden of FORBIDDEN_REQUEST_KEY_FIELDS) {
        const payload = { ...base, [forbidden]: "leaked-private-key" };
        const result = schema.safeParse(payload);
        expect(
          result.success,
          `${name} must reject forbidden request field "${forbidden}"`,
        ).toBe(false);
      }
    }
  });

  it("rejects a PEM that is actually a private key in the public-key slot", () => {
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    expect(
      OtpVerifySchema.safeParse({
        challengeId: "chal_1",
        code: "123456",
        clientPublicKeyPem: privatePem,
        timezone: "Asia/Kolkata",
      }).success,
    ).toBe(false);
  });
});

describe("responder/dashboard exclusion contract (R5.5, R15.5, R19.1, R29.7)", () => {
  const responderBase = {
    preferredName: "Amma",
    incidentStage: "STAGE_4_HYPERLOCAL_DISPATCH",
  };

  it("accepts a valid responder triage payload with no forbidden fields", () => {
    expect(ResponderTriagePayloadSchema.safeParse(responderBase).success).toBe(true);
  });

  it("rejects location/financial/chat fields on the responder payload", () => {
    for (const forbidden of FORBIDDEN_RESPONDER_FIELDS) {
      const payload = { ...responderBase, [forbidden]: "should-not-exist" };
      expect(
        ResponderTriagePayloadSchema.safeParse(payload).success,
        `responder payload must reject "${forbidden}"`,
      ).toBe(false);
    }
  });

  it("rejects a continuous location trace on the observer dashboard entry", () => {
    const wellBeing = { anchorId: "a_1", preferredName: "Amma", state: "ALL_WELL" };
    expect(AnchorWellBeingSchema.safeParse(wellBeing).success).toBe(true);
    for (const forbidden of FORBIDDEN_RESPONDER_FIELDS) {
      expect(
        AnchorWellBeingSchema.safeParse({ ...wellBeing, [forbidden]: 1 }).success,
        `observer dashboard entry must reject "${forbidden}"`,
      ).toBe(false);
    }
  });

  it("wraps well-being entries in the observer dashboard container", () => {
    expect(
      ObserverDashboardSchema.safeParse({
        anchors: [{ anchorId: "a_1", preferredName: "Amma", state: "ALL_WELL" }],
      }).success,
    ).toBe(true);
  });
});

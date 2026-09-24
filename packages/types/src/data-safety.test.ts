/**
 * Data_Safety_Disclosure consistency contract test (R27.1–R27.5).
 *
 * Asserts the app-store Data_Safety_Disclosure manifest
 * (`DATA_SAFETY_DISCLOSURE`) stays consistent with the ACTUAL data the
 * platform collects/declares — i.e. every disclosed category maps to a real
 * DTO field, no undisclosed collecting field slips in, and the privacy
 * affirmations (never sold, no cross-app tracking, server-blind black-box, no
 * plaintext continuous-location trace on servers) hold structurally against
 * the schemas in `@kshema/types`.
 *
 * The test is hermetic: it exercises only in-memory Zod schemas and the
 * manifest — no network, filesystem, or database.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DATA_SAFETY_DISCLOSURE,
  DATA_SAFETY_CATEGORIES,
  DATA_SAFETY_CATEGORY_IDS,
  FORBIDDEN_RESPONDER_FIELDS,
  HeartbeatSchema,
  BulkSyncSchema,
  OtpVerifySchema,
  BlackBoxSyncSchema,
  BlackBoxCiphertextSchema,
} from "./index.js";

/** Extract the top-level object keys a Zod object schema accepts. */
function objectKeys(schema: z.ZodTypeAny): string[] {
  // Narrow to a ZodObject to read its shape; every collecting DTO here is one.
  const obj = schema as unknown as z.ZodObject<z.ZodRawShape>;
  return Object.keys(obj.shape);
}

/**
 * The union of fields across the DTOs the app can send that actually collect
 * user data (the telemetry heartbeat + the auth/registration payload). This
 * is the "reality" the disclosure must match.
 */
const COLLECTING_DTO_FIELDS = new Set<string>([
  ...objectKeys(HeartbeatSchema),
  ...objectKeys(OtpVerifySchema),
]);

describe("Data_Safety_Disclosure ⇄ DTO reality (R27.5)", () => {
  it("declares device identifiers + push tokens backed by real DTO fields (R27.1)", () => {
    const deviceCat = DATA_SAFETY_CATEGORIES.find((c) => c.id === "device_identifiers");
    const pushCat = DATA_SAFETY_CATEGORIES.find((c) => c.id === "push_tokens");

    expect(deviceCat, "device_identifiers category must be declared").toBeDefined();
    expect(pushCat, "push_tokens category must be declared").toBeDefined();

    // Each declared DTO field must exist on a collecting schema.
    expect(objectKeys(HeartbeatSchema)).toContain("deviceId");
    expect(objectKeys(OtpVerifySchema)).toContain("pushToken");

    for (const field of deviceCat!.dtoFields) {
      expect(COLLECTING_DTO_FIELDS, `device id field "${field}" must be a real DTO field`).toContain(
        field,
      );
    }
    for (const field of pushCat!.dtoFields) {
      expect(COLLECTING_DTO_FIELDS, `push token field "${field}" must be a real DTO field`).toContain(
        field,
      );
    }
  });

  it("declares step-delta diagnostics backed by the heartbeat DTO (R27.2)", () => {
    const diag = DATA_SAFETY_CATEGORIES.find((c) => c.id === "step_delta_diagnostics");
    expect(diag, "step_delta_diagnostics category must be declared").toBeDefined();
    expect(objectKeys(HeartbeatSchema)).toContain("stepDelta");
    for (const field of diag!.dtoFields) {
      expect(COLLECTING_DTO_FIELDS, `diagnostic field "${field}" must be a real DTO field`).toContain(
        field,
      );
    }
  });

  it("every declared category maps to at least one existing DTO field", () => {
    for (const category of DATA_SAFETY_CATEGORIES) {
      expect(category.dtoFields.length, `${category.id} must map to a DTO field`).toBeGreaterThan(0);
      for (const field of category.dtoFields) {
        expect(
          COLLECTING_DTO_FIELDS,
          `disclosed category "${category.id}" references non-existent DTO field "${field}"`,
        ).toContain(field);
      }
    }
  });

  it("uses a stable, de-duplicated category id set", () => {
    const ids = DATA_SAFETY_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...DATA_SAFETY_CATEGORY_IDS].sort());
  });
});

describe("no undisclosed collection (R27.5)", () => {
  /**
   * Every user-data-bearing field on the collecting DTOs must be either a
   * declared category field OR a benign non-personal envelope field. If a new
   * collecting field is added without updating the disclosure, this fails.
   */
  const DECLARED_FIELDS = new Set(DATA_SAFETY_CATEGORIES.flatMap((c) => c.dtoFields));

  // Envelope / non-personal fields that need no data-safety declaration.
  const NON_DECLARABLE_FIELDS = new Set<string>([
    "capturedAt", // timestamp of the reading
    "screenUnlocks", // local activity timestamps (diagnostic rhythm, not identity)
    "battery", // device power level
    "chargerState", // charger connected/disconnected
    "challengeId", // OTP challenge handle
    "code", // one-time code (not stored)
    "clientPublicKeyPem", // public key material only
    "preferredName", // display name chosen by the user
    "timezone", // IANA timezone for rhythm scheduling
  ]);

  it("has no collecting DTO field that is neither declared nor a benign envelope field", () => {
    for (const field of COLLECTING_DTO_FIELDS) {
      const known = DECLARED_FIELDS.has(field) || NON_DECLARABLE_FIELDS.has(field);
      expect(
        known,
        `DTO field "${field}" is collected but not covered by the Data_Safety_Disclosure`,
      ).toBe(true);
    }
  });
});

describe("no plaintext continuous location on servers (R27.4, R19.1)", () => {
  it("affirms no continuous location trace on servers", () => {
    expect(DATA_SAFETY_DISCLOSURE.affirmations.noContinuousLocationOnServers).toBe(true);
  });

  it("telemetry DTOs structurally reject any continuous-location field", () => {
    for (const field of FORBIDDEN_RESPONDER_FIELDS) {
      // A single heartbeat must reject the location-ish field.
      const heartbeat = {
        deviceId: "dev_1",
        capturedAt: "2024-01-01T05:30:00.000Z",
        [field]: 1,
      };
      expect(
        HeartbeatSchema.safeParse(heartbeat).success,
        `HeartbeatSchema must reject forbidden field "${field}"`,
      ).toBe(false);

      // ...and so must a bulk-sync carrying such a heartbeat.
      const bulk = {
        deviceId: "dev_1",
        heartbeats: [{ deviceId: "dev_1", capturedAt: "2024-01-01T05:30:00.000Z", [field]: 1 }],
      };
      expect(
        BulkSyncSchema.safeParse(bulk).success,
        `BulkSyncSchema must reject forbidden field "${field}"`,
      ).toBe(false);
    }
  });

  it("a location-free heartbeat is still accepted", () => {
    expect(
      HeartbeatSchema.safeParse({
        deviceId: "dev_1",
        capturedAt: "2024-01-01T05:30:00.000Z",
        stepDelta: 42,
      }).success,
    ).toBe(true);
  });
});

describe("server-blind black box (R27.4, R8.6, R19.3)", () => {
  it("affirms the server is blind to sealed context", () => {
    expect(DATA_SAFETY_DISCLOSURE.affirmations.serverBlindToBlackBox).toBe(true);
  });

  it("black-box DTOs carry only ciphertext + wrapped keys — never plaintext or a private key", () => {
    const syncKeys = objectKeys(BlackBoxSyncSchema);
    const fetchKeys = objectKeys(BlackBoxCiphertextSchema);
    const plaintextish = ["plaintext", "decrypted", "privateKey", "privateKeyPem", "payloadKey"];
    for (const forbidden of plaintextish) {
      expect(syncKeys, `black-box sync must not carry "${forbidden}"`).not.toContain(forbidden);
      expect(fetchKeys, `black-box fetch must not carry "${forbidden}"`).not.toContain(forbidden);
    }
    // The transported payload is opaque ciphertext.
    expect(syncKeys).toContain("encryptedPayload");
    expect(fetchKeys).toContain("encryptedPayload");
  });

  it("black-box sync structurally rejects an injected plaintext field", () => {
    const base = {
      circleId: "c_1",
      encryptedPayload: "cipher",
      iv: "iv",
      authTag: "tag",
      recipientKeys: [{ observerId: "o_1", wrappedKey: "wrapped" }],
      capturedRange: { start: "2024-01-01T00:00:00.000Z", end: "2024-01-01T00:05:00.000Z" },
    };
    expect(BlackBoxSyncSchema.safeParse(base).success).toBe(true);
    expect(
      BlackBoxSyncSchema.safeParse({ ...base, plaintext: "leak" }).success,
      "black-box sync must reject a plaintext field",
    ).toBe(false);
  });
});

describe("never sold / no cross-app tracking (R27.3, R30.7)", () => {
  it("affirms data is never sold or traded", () => {
    expect(DATA_SAFETY_DISCLOSURE.affirmations.dataNeverSold).toBe(true);
  });

  it("affirms no cross-app / cross-company tracking", () => {
    expect(DATA_SAFETY_DISCLOSURE.affirmations.noCrossAppTracking).toBe(true);
  });

  it("declares no category as shared with third parties (consistent with 'never sold')", () => {
    for (const category of DATA_SAFETY_CATEGORIES) {
      expect(category.shared, `${category.id} must not be shared when data is never sold`).toBe(false);
    }
  });
});

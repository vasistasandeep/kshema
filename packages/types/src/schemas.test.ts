/**
 * Behavior tests for @kshema/types domain schemas.
 */
import { describe, expect, it } from "vitest";

import {
  OtpRequestSchema,
  BulkSyncSchema,
  BlackBoxSyncSchema,
  TriggerSosSchema,
  CreateSanctuarySchema,
  VoiceNoteSchema,
  SparshRhythmQuerySchema,
  UpdateMemberPermissionsSchema,
} from "./index.js";

describe("auth OtpRequestSchema", () => {
  it("accepts an E.164 phone", () => {
    expect(OtpRequestSchema.safeParse({ phone: "+919876543210" }).success).toBe(true);
  });

  it("rejects a malformed phone", () => {
    expect(OtpRequestSchema.safeParse({ phone: "abc" }).success).toBe(false);
  });
});

describe("telemetry BulkSyncSchema", () => {
  it("defaults empty arrays and requires a deviceId", () => {
    const parsed = BulkSyncSchema.parse({ deviceId: "dev_1" });
    expect(parsed.heartbeats).toEqual([]);
    expect(parsed.ghostSignals).toEqual([]);
  });

  it("carries no continuous-location field on a heartbeat", () => {
    const withLocation = {
      deviceId: "dev_1",
      heartbeats: [
        {
          deviceId: "dev_1",
          capturedAt: "2024-01-01T05:30:00.000Z",
          latitude: 12.9,
        },
      ],
    };
    expect(BulkSyncSchema.safeParse(withLocation).success).toBe(false);
  });
});

describe("blackbox BlackBoxSyncSchema", () => {
  it("requires at least one recipient key", () => {
    const base = {
      circleId: "c_1",
      encryptedPayload: "cipher",
      iv: "iv",
      authTag: "tag",
      recipientKeys: [],
      capturedRange: { start: "2024-01-01T00:00:00.000Z", end: "2024-01-01T00:03:00.000Z" },
    };
    expect(BlackBoxSyncSchema.safeParse(base).success).toBe(false);
    expect(
      BlackBoxSyncSchema.safeParse({
        ...base,
        recipientKeys: [{ observerId: "o_1", wrappedKey: "wrapped" }],
      }).success,
    ).toBe(true);
  });
});

describe("incident TriggerSosSchema", () => {
  it("accepts an omitted or point-in-time SOS location", () => {
    expect(TriggerSosSchema.safeParse({}).success).toBe(true);
    expect(
      TriggerSosSchema.safeParse({
        decryptedLocation: {
          latitude: 12.9,
          longitude: 77.5,
          capturedAt: "2024-01-01T05:30:00.000Z",
        },
      }).success,
    ).toBe(true);
  });
});

describe("sanctuary CreateSanctuarySchema", () => {
  const start = "2024-01-01T00:00:00.000Z";
  it("accepts a window within 14 days", () => {
    expect(
      CreateSanctuarySchema.safeParse({
        anchorId: "a_1",
        startsAt: start,
        resumesAt: "2024-01-10T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects a window longer than 14 days", () => {
    expect(
      CreateSanctuarySchema.safeParse({
        anchorId: "a_1",
        startsAt: start,
        resumesAt: "2024-02-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects a resume that is not after the start", () => {
    expect(
      CreateSanctuarySchema.safeParse({
        anchorId: "a_1",
        startsAt: start,
        resumesAt: start,
      }).success,
    ).toBe(false);
  });
});

describe("vitality VoiceNoteSchema", () => {
  it("rejects a voice note longer than 10 seconds", () => {
    expect(
      VoiceNoteSchema.safeParse({ anchorId: "a_1", audio: "b64", durationSeconds: 12 }).success,
    ).toBe(false);
  });
});

describe("vitality SparshRhythmQuerySchema", () => {
  it("coerces a query-string day count and defaults to 30", () => {
    expect(SparshRhythmQuerySchema.parse({}).days).toBe(30);
    expect(SparshRhythmQuerySchema.parse({ days: "45" }).days).toBe(45);
  });
});

describe("circles UpdateMemberPermissionsSchema", () => {
  it("requires at least one permission field", () => {
    expect(UpdateMemberPermissionsSchema.safeParse({}).success).toBe(false);
    expect(UpdateMemberPermissionsSchema.safeParse({ canTriggerIVR: true }).success).toBe(true);
  });
});

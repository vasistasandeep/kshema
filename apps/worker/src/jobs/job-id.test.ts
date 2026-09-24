import { describe, expect, it } from "vitest";

import {
  escalationJobId,
  graceCheckJobId,
  vitalityPulseJobId,
  type StageNumber,
} from "./job-id.js";

describe("escalationJobId — incident:<id>:stageN scheme", () => {
  it("formats the canonical incident:<id>:stageN id", () => {
    expect(escalationJobId("abc", 2)).toBe("incident:abc:stage2");
    expect(escalationJobId("xyz", 4)).toBe("incident:xyz:stage4");
  });

  it("is deterministic — identical inputs yield identical ids", () => {
    const a = escalationJobId("incident-1", 3);
    const b = escalationJobId("incident-1", 3);
    expect(a).toBe(b);
  });

  it("produces distinct ids per stage for the same incident", () => {
    const stages: StageNumber[] = [1, 2, 3, 4];
    const ids = stages.map((s) => escalationJobId("inc", s));
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual([
      "incident:inc:stage1",
      "incident:inc:stage2",
      "incident:inc:stage3",
      "incident:inc:stage4",
    ]);
  });

  it("produces distinct ids per incident for the same stage", () => {
    expect(escalationJobId("a", 2)).not.toBe(escalationJobId("b", 2));
  });

  it("rejects empty or malformed incident ids", () => {
    expect(() => escalationJobId("", 1)).toThrow(/non-empty/);
    expect(() => escalationJobId("has:colon", 1)).toThrow(/must not contain/);
    expect(() => escalationJobId("has space", 1)).toThrow(/must not contain/);
  });
});

describe("graceCheckJobId — rhythm:<anchor>:grace-check:<day>", () => {
  it("formats and is deterministic", () => {
    expect(graceCheckJobId("anchor1", "2025-01-31")).toBe(
      "rhythm:anchor1:grace-check:2025-01-31",
    );
    expect(graceCheckJobId("anchor1", "2025-01-31")).toBe(
      graceCheckJobId("anchor1", "2025-01-31"),
    );
  });

  it("differs by anchor and by service day", () => {
    expect(graceCheckJobId("a", "2025-01-31")).not.toBe(
      graceCheckJobId("b", "2025-01-31"),
    );
    expect(graceCheckJobId("a", "2025-01-31")).not.toBe(
      graceCheckJobId("a", "2025-02-01"),
    );
  });

  it("rejects malformed segments", () => {
    expect(() => graceCheckJobId("", "2025-01-31")).toThrow(/non-empty/);
    expect(() => graceCheckJobId("a", "bad day")).toThrow(/must not contain/);
  });
});

describe("vitalityPulseJobId — vitality:<anchor>:pulse:<day>", () => {
  it("formats, is deterministic, and is unique per anchor+day", () => {
    expect(vitalityPulseJobId("anchor1", "2025-01-31")).toBe(
      "vitality:anchor1:pulse:2025-01-31",
    );
    expect(vitalityPulseJobId("anchor1", "2025-01-31")).toBe(
      vitalityPulseJobId("anchor1", "2025-01-31"),
    );
    expect(vitalityPulseJobId("a", "2025-01-31")).not.toBe(
      vitalityPulseJobId("a", "2025-02-01"),
    );
  });
});

describe("cross-scheme uniqueness", () => {
  it("namespaces prevent collisions across queues", () => {
    const ids = new Set([
      escalationJobId("x", 1),
      graceCheckJobId("x", "2025-01-31"),
      vitalityPulseJobId("x", "2025-01-31"),
    ]);
    expect(ids.size).toBe(3);
  });
});

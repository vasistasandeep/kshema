import { describe, expect, it, vi } from "vitest";

import { graceCheckJobId } from "../jobs/job-id.js";
import {
  buildGraceCheckDescriptor,
  scheduleGraceCheck,
  type GraceCheckScheduleInput,
} from "./grace-check-scheduler.js";

const DAY_START = Date.UTC(2025, 0, 31, 0, 0, 0); // local-midnight stand-in
const MS_PER_MINUTE = 60_000;

function scheduleInput(
  overrides: Partial<GraceCheckScheduleInput> = {},
): GraceCheckScheduleInput {
  return {
    anchorId: "anchor1",
    serviceDay: "2025-01-31",
    dayStart: DAY_START,
    now: DAY_START,
    deadline: {
      mean: 420, // 07:00
      stdDev: 0,
      isWeekend: false,
      priorDaySteps: 0,
      avgStep30d: 0,
    },
    ...overrides,
  };
}

describe("buildGraceCheckDescriptor (R4.3, task 9.1)", () => {
  it("uses the deterministic graceCheckJobId", () => {
    const d = buildGraceCheckDescriptor(scheduleInput());
    expect(d.jobId).toBe(graceCheckJobId("anchor1", "2025-01-31"));
  });

  it("maps the deadline minute-of-day onto an absolute fire-at instant", () => {
    const d = buildGraceCheckDescriptor(scheduleInput());
    expect(d.deadlineMinuteOfDay).toBe(420);
    expect(d.fireAt).toBe(DAY_START + 420 * MS_PER_MINUTE);
    expect(d.delayMs).toBe(420 * MS_PER_MINUTE);
    expect(d.wrapsPastMidnight).toBe(false);
  });

  it("clamps delay to zero when the deadline is already in the past", () => {
    const d = buildGraceCheckDescriptor(
      scheduleInput({ now: DAY_START + 1000 * MS_PER_MINUTE }),
    );
    expect(d.delayMs).toBe(0);
  });

  it("adds a full day when the deadline wraps past midnight", () => {
    // mean 1400 + 2*stdDev 30 = 1460 > 1440 => wraps; minuteOfDay = 1460 % 1440 = 20.
    const d = buildGraceCheckDescriptor(
      scheduleInput({
        deadline: {
          mean: 1400,
          stdDev: 30,
          isWeekend: false,
          priorDaySteps: 0,
          avgStep30d: 0,
        },
      }),
    );
    expect(d.wrapsPastMidnight).toBe(true);
    expect(d.deadlineMinuteOfDay).toBe(20);
    expect(d.fireAt).toBe(
      DAY_START + 20 * MS_PER_MINUTE + 24 * 60 * MS_PER_MINUTE,
    );
  });
});

describe("scheduleGraceCheck", () => {
  it("hands the descriptor to the injected enqueue seam (hermetic)", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const descriptor = await scheduleGraceCheck(scheduleInput(), enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(descriptor);
    expect(descriptor.jobId).toBe(graceCheckJobId("anchor1", "2025-01-31"));
  });
});

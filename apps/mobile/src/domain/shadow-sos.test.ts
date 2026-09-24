/**
 * Shadow SOS tests (task 22.3): the Android 4×-power-within-2.5s detector
 * (R11.1), and the Blackout_Mode + silent-dispatch controller (R11.3–R11.7).
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  ANDROID_POWER_PRESS_WINDOW_MS,
  BlackoutScreen,
  PowerButtonTrigger,
  ShadowSosController,
  ShadowSosDispatcher,
} from "./shadow-sos.js";

describe("PowerButtonTrigger (R11.1)", () => {
  it("fires on the 4th press within 2.5s", () => {
    const t = new PowerButtonTrigger();
    expect(t.press(0)).toBe(false);
    expect(t.press(500)).toBe(false);
    expect(t.press(1000)).toBe(false);
    expect(t.press(2000)).toBe(true); // 4 presses within 2.5s
  });

  it("does NOT fire when the 4 presses span more than 2.5s", () => {
    const t = new PowerButtonTrigger();
    expect(t.press(0)).toBe(false);
    expect(t.press(1000)).toBe(false);
    expect(t.press(2000)).toBe(false);
    // 4th press at 2600ms → first press (0) is outside the window, only 3 remain.
    expect(t.press(2600)).toBe(false);
  });

  it("fires once per burst, then requires a fresh burst", () => {
    const t = new PowerButtonTrigger();
    t.press(0);
    t.press(100);
    t.press(200);
    expect(t.press(300)).toBe(true);
    // Immediately after firing, the window is cleared.
    expect(t.press(400)).toBe(false);
  });

  it("fires iff 4 presses fall within the 2.5s window (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 4, maxLength: 4 }),
        (gaps) => {
          const t = new PowerButtonTrigger();
          let at = 1000;
          let fired = false;
          const times: number[] = [];
          for (const g of gaps) {
            at += g * 100; // 0..5000ms gaps
            times.push(at);
            fired = t.press(at) || fired;
          }
          // The 4 presses fired iff they all fall within the window.
          const span = times[3]! - times[0]!;
          expect(fired).toBe(span <= ANDROID_POWER_PRESS_WINDOW_MS);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("ShadowSosController Blackout_Mode (R11.3, R11.7)", () => {
  function make() {
    const dispatched: unknown[] = [];
    const dispatcher: ShadowSosDispatcher = {
      dispatch: vi.fn(async (input) => {
        dispatched.push(input);
      }),
    };
    const blackout: BlackoutScreen = {
      enter: vi.fn(async () => {}),
      exit: vi.fn(async () => {}),
    };
    const controller = new ShadowSosController({ dispatcher, blackout });
    return { controller, dispatcher, blackout, dispatched };
  }

  it("enters Blackout_Mode and silently dispatches on trigger", async () => {
    const { controller, dispatcher, blackout } = make();
    expect(controller.shouldSuppressIndicators()).toBe(false);

    await controller.trigger("ANDROID_POWER_4X", 1234);
    expect(blackout.enter).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith({
      kind: "ANDROID_POWER_4X",
      triggeredAt: 1234,
    });
    // While active, indicators are suppressed (R11.7).
    expect(controller.blackoutState).toBe("ACTIVE");
    expect(controller.shouldSuppressIndicators()).toBe(true);
  });

  it("re-dispatches on a second trigger without a second blackout transition", async () => {
    const { controller, dispatcher, blackout } = make();
    await controller.trigger("ANDROID_POWER_4X", 1);
    await controller.trigger("IOS_DURESS_ACTION", 2);
    expect(blackout.enter).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("exits Blackout_Mode and restores indicators", async () => {
    const { controller, blackout } = make();
    await controller.trigger("IOS_DURESS_ACTION", 1);
    await controller.exitBlackout();
    expect(blackout.exit).toHaveBeenCalledTimes(1);
    expect(controller.shouldSuppressIndicators()).toBe(false);
  });
});

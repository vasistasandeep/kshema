/**
 * Silent Hardware Shadow SOS + Blackout Mode — on-device triggers
 * (R11.1, R11.2, R11.3, R11.7; task 22.3).
 *
 * A Shadow_SOS is a covert duress signal the Anchor raises with a hardware
 * gesture, without any on-screen tap a nearby threat could notice:
 *   - **Android** (R11.1): pressing the power button **4 times within 2.5s**.
 *   - **iOS** (R11.2): invoking a registered duress action (an Action Button /
 *     Shortcuts automation / Back-Tap), surfaced to us as a single event.
 *
 * When triggered the app enters **Blackout_Mode** (R11.3): the screen mimics a
 * powered-off device while, in the background, the platform silently POSTs
 * `/incidents/trigger-sos` (worker releases black boxes + includes decrypted
 * location — R11.4–R11.6, handled server-side in tasks 7.1/10.3). While
 * Blackout_Mode is active the app suppresses all audible and visible alert
 * indicators on the Anchor device (R11.7).
 *
 * This module owns the framework-agnostic pieces:
 *   - {@link PowerButtonTrigger}: the Android 4-press-within-2.5s detector (pure,
 *     fed raw power-button timestamps by the platform broadcast receiver),
 *   - {@link ShadowSosController}: dispatch + Blackout_Mode state machine behind
 *     injectable seams ({@link ShadowSosDispatcher}, {@link BlackoutScreen}).
 * The native key/broadcast plumbing lives in the Expo platform binding.
 */

/** How the Shadow_SOS was triggered, recorded for the incident. */
export type ShadowSosTriggerKind = "ANDROID_POWER_4X" | "IOS_DURESS_ACTION";

/** Number of power presses that trigger a Shadow_SOS on Android (R11.1). */
export const ANDROID_POWER_PRESS_COUNT = 4;

/** Window (ms) the 4 presses must fall within on Android (R11.1). */
export const ANDROID_POWER_PRESS_WINDOW_MS = 2500;

/**
 * Pure sliding-window detector for the Android power-button gesture (R11.1).
 *
 * The platform registers a broadcast receiver for screen-on/off (power button)
 * events and calls {@link press} with each press timestamp. The detector keeps a
 * short trailing window of press times and fires when {@link ANDROID_POWER_PRESS_COUNT}
 * (4) presses fall within {@link ANDROID_POWER_PRESS_WINDOW_MS} (2.5s). After
 * firing it clears the window so the same burst cannot double-fire.
 *
 * The detector holds no timers and reads no clock — the caller supplies each
 * timestamp — so it is deterministic and unit-testable.
 */
export class PowerButtonTrigger {
  private readonly presses: number[] = [];

  constructor(
    private readonly count: number = ANDROID_POWER_PRESS_COUNT,
    private readonly windowMs: number = ANDROID_POWER_PRESS_WINDOW_MS,
  ) {}

  /**
   * Record a power-button press at time `at` (epoch-millis). Returns `true`
   * exactly on the press that completes {@link count} presses within
   * {@link windowMs}; the window is then cleared so a single burst fires once.
   */
  press(at: number): boolean {
    // Drop presses that fall outside the trailing window relative to `at`.
    const cutoff = at - this.windowMs;
    while (this.presses.length > 0 && this.presses[0]! < cutoff) {
      this.presses.shift();
    }
    this.presses.push(at);

    if (this.presses.length >= this.count) {
      this.presses.length = 0;
      return true;
    }
    return false;
  }

  /** Reset the press window (e.g. on app foreground/config change). */
  reset(): void {
    this.presses.length = 0;
  }
}

/**
 * Seam that silently dispatches the Shadow_SOS to the API
 * (`POST /incidents/trigger-sos`). The platform binding supplies the Anchor's
 * decrypted location so the worker can include it in the Observer alert
 * (R11.5); the server releases black boxes to permitted Observers (R11.6). No
 * UI is shown. A spy in tests.
 */
export interface ShadowSosDispatcher {
  dispatch(input: {
    kind: ShadowSosTriggerKind;
    triggeredAt: number;
  }): Promise<void>;
}

/**
 * Seam that drives the Blackout_Mode screen (R11.3, R11.7): show a fake
 * powered-off screen and suppress audible/visible alert indicators; hide it on
 * exit. Implemented by the Expo UI layer; a spy in tests.
 */
export interface BlackoutScreen {
  /** Enter Blackout_Mode: mimic powered-off, suppress all alert indicators. */
  enter(): Promise<void> | void;
  /** Exit Blackout_Mode: restore the normal UI. */
  exit(): Promise<void> | void;
}

/** Current Blackout_Mode state exposed for the UI/tests. */
export type BlackoutState = "OFF" | "ACTIVE";

/**
 * Coordinates a Shadow_SOS: on trigger it enters Blackout_Mode *and* silently
 * dispatches to the API (R11.3–R11.6), and while active it reports the blackout
 * state so the UI suppresses indicators (R11.7). Idempotent: a second trigger
 * while already blacked out re-dispatches (a duress user may re-signal) but does
 * not stack UI transitions.
 */
export class ShadowSosController {
  private state: BlackoutState = "OFF";

  constructor(
    private readonly deps: {
      dispatcher: ShadowSosDispatcher;
      blackout: BlackoutScreen;
    },
  ) {}

  /** Whether Blackout_Mode is currently active (drives indicator suppression). */
  get blackoutState(): BlackoutState {
    return this.state;
  }

  /**
   * Whether the Anchor device should suppress audible/visible alert indicators
   * right now (R11.7) — true exactly while Blackout_Mode is active.
   */
  shouldSuppressIndicators(): boolean {
    return this.state === "ACTIVE";
  }

  /**
   * Trigger a Shadow_SOS (R11.1/R11.2 → R11.3–R11.6). Enters Blackout_Mode if
   * not already active, then dispatches silently to the API. Dispatch happens on
   * every trigger; the Blackout_Mode transition happens only on the first.
   */
  async trigger(kind: ShadowSosTriggerKind, triggeredAt: number): Promise<void> {
    if (this.state !== "ACTIVE") {
      this.state = "ACTIVE";
      await this.deps.blackout.enter();
    }
    await this.deps.dispatcher.dispatch({ kind, triggeredAt });
  }

  /**
   * Exit Blackout_Mode (e.g. Anchor safely disarms with a covert exit gesture).
   * Restores the normal UI and re-enables indicators. No-op if already off.
   */
  async exitBlackout(): Promise<void> {
    if (this.state !== "OFF") {
      this.state = "OFF";
      await this.deps.blackout.exit();
    }
  }
}

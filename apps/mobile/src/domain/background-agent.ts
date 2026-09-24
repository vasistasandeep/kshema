/**
 * Background reliability + battery-survival orchestration (R18.1-R18.5).
 *
 * Ambient protection must keep running when the app is backgrounded so the
 * Circle is never falsely alarmed by the OS killing the process (R18). This
 * module holds the pure decision logic for that survival strategy:
 *
 *   - Android runs a minimum-priority foreground service while ambient
 *     protection is active (R18.1); iOS relies on registered background tasks.
 *   - Onboarding guides a battery-optimization exemption on Android (R18.2),
 *     more insistently on OEMs known for aggressive background killing.
 *   - Screen-presence and power-state broadcast receivers feed passive signals
 *     while backgrounded (R18.3) — bound in the platform layer.
 *   - If background execution is lost, the Anchor is notified to restore
 *     protection (R18.4).
 *   - The device's background-execution configuration is captured into a
 *     `DeviceConfig` snapshot for fleet health (R18.5), mirroring the Prisma
 *     `DeviceConfig` model.
 *
 * The OS/native surface is injected behind the interfaces below so all of this
 * is unit-testable under Node.
 */

/** Device platform. Mirrors the `DeviceConfig.platform` values. */
export type DevicePlatform = "ANDROID" | "IOS";

/**
 * Android OEMs known for aggressive background-task killing. These get a more
 * insistent battery-exemption onboarding prompt (R18.2). Matched against a
 * normalized manufacturer string.
 */
export const AGGRESSIVE_BATTERY_OEMS = [
  "xiaomi",
  "oppo",
  "vivo",
  "oneplus",
  "realme",
  "huawei",
  "samsung",
] as const;

/** Whether an OEM string is one of the known aggressive-battery manufacturers. */
export function isAggressiveBatteryOem(oem: string | null | undefined): boolean {
  if (!oem) return false;
  const normalized = oem.trim().toLowerCase();
  return AGGRESSIVE_BATTERY_OEMS.some((known) => normalized.includes(known));
}

/** Live device background-execution facts read from the OS. */
export interface DeviceBackgroundState {
  readonly platform: DevicePlatform;
  /** Manufacturer, e.g. "Xiaomi", "Apple". Null when unavailable. */
  readonly oem?: string | null;
  /** Whether the app is exempt from OS battery optimization (Android, R18.2). */
  readonly batteryExempt: boolean;
  /**
   * Whether the Android minimum-priority foreground service is currently
   * running (R18.1). Always false on iOS, which uses background tasks instead.
   */
  readonly foregroundServiceActive: boolean;
}

/**
 * `DeviceConfig` snapshot persisted for fleet health (R18.5). Mirrors the
 * Prisma `DeviceConfig` model fields the app owns.
 */
export interface DeviceConfigSnapshot {
  readonly platform: DevicePlatform;
  readonly oem: string | null;
  readonly batteryExempt: boolean;
  readonly foregroundServiceActive: boolean;
  /** ISO timestamp of the last successful telemetry sync, if known. */
  readonly lastTelemetrySyncAt?: string;
}

/**
 * Capture a {@link DeviceConfigSnapshot} from the live background state (R18.5).
 * `lastTelemetrySyncAt` comes from the Offline_Telemetry_Queue's last flush.
 */
export function captureDeviceConfig(
  state: DeviceBackgroundState,
  lastTelemetrySyncAt?: string,
): DeviceConfigSnapshot {
  const snapshot: DeviceConfigSnapshot = {
    platform: state.platform,
    oem: state.oem ?? null,
    batteryExempt: state.batteryExempt,
    foregroundServiceActive: state.foregroundServiceActive,
  };
  return lastTelemetrySyncAt !== undefined
    ? { ...snapshot, lastTelemetrySyncAt }
    : snapshot;
}

/** The onboarding step the app should present for background survival (R18.2). */
export type BatteryOnboardingStep =
  /** Android, not yet exempt — request the exemption. `insistent` on aggressive OEMs. */
  | { readonly kind: "REQUEST_BATTERY_EXEMPTION"; readonly insistent: boolean }
  /** Already exempt (or iOS, which needs no exemption) — nothing to prompt. */
  | { readonly kind: "NONE" };

/**
 * Decide the battery-optimization onboarding step (R18.2). iOS never needs a
 * battery exemption; Android needs one until granted, and OEMs known to kill
 * background work aggressively get the insistent variant.
 */
export function planBatteryOnboarding(
  state: DeviceBackgroundState,
): BatteryOnboardingStep {
  if (state.platform !== "ANDROID" || state.batteryExempt) {
    return { kind: "NONE" };
  }
  return {
    kind: "REQUEST_BATTERY_EXEMPTION",
    insistent: isAggressiveBatteryOem(state.oem),
  };
}

/**
 * R18.4 — whether the app has lost background execution capability and must
 * notify the Anchor to restore ambient protection. On Android, ambient
 * protection depends on the minimum-priority foreground service running; if it
 * is not active while protection is meant to be on, execution is considered
 * lost. iOS background tasks are best-effort and are not treated as a hard
 * loss here (the OS reschedules them), so this returns false on iOS.
 *
 * @param protectionEnabled whether the Anchor has Ambient_Shield turned on.
 */
export function hasLostBackgroundExecution(
  state: DeviceBackgroundState,
  protectionEnabled: boolean,
): boolean {
  if (!protectionEnabled) return false;
  if (state.platform !== "ANDROID") return false;
  return !state.foregroundServiceActive;
}

/** The lost-execution notification the Anchor should see (R18.4). */
export interface RestoreProtectionNotification {
  readonly kind: "RESTORE_AMBIENT_PROTECTION";
  /** True when a battery-optimization exemption is the likely remedy. */
  readonly suggestBatteryExemption: boolean;
}

/**
 * Build the R18.4 lost-execution notification when background execution has
 * been lost, otherwise `null`. Suggests the battery exemption as the remedy
 * when the device is not yet exempt.
 */
export function planLostExecutionNotification(
  state: DeviceBackgroundState,
  protectionEnabled: boolean,
): RestoreProtectionNotification | null {
  if (!hasLostBackgroundExecution(state, protectionEnabled)) return null;
  return {
    kind: "RESTORE_AMBIENT_PROTECTION",
    suggestBatteryExemption: !state.batteryExempt,
  };
}

/**
 * Native control surface for the Android minimum-priority foreground service
 * (R18.1). No-op on iOS bindings. Injected so the agent lifecycle is testable.
 */
export interface ForegroundServiceController {
  start(): Promise<void>;
  stop(): Promise<void>;
  isActive(): Promise<boolean>;
}

/** Source of the live {@link DeviceBackgroundState} from the OS. */
export interface DeviceBackgroundStateSource {
  read(): Promise<DeviceBackgroundState>;
}

/** Requests the OS battery-optimization exemption (Android). */
export interface BatteryExemptionRequester {
  /** Prompt the user; resolves to whether the exemption is now granted. */
  request(): Promise<boolean>;
}

/** Delivers the R18.4 restore-protection notification to the Anchor. */
export interface RestoreProtectionNotifier {
  notify(notification: RestoreProtectionNotification): Promise<void>;
}

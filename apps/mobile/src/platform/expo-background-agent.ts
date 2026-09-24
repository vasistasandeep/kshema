/**
 * Expo/React Native bindings for the background reliability surface
 * (R18.1-R18.5).
 *
 * These wire the framework-agnostic domain contracts in
 * `../domain/background-agent` to the device. The Android minimum-priority
 * foreground service, screen/power broadcast receivers, and iOS background
 * tasks require the Expo native toolchain (a custom/dev client — not Expo Go)
 * and native modules that are NOT part of the Node CI graph. To keep this file
 * compiling in the app build without hard-depending on optional native
 * packages, the native surface is INJECTED behind small interfaces, exactly as
 * `native-keygen.ts` does for RSA. A dev/custom build supplies the concrete
 * modules (e.g. `expo-task-manager`, `expo-notifications`,
 * `react-native-foreground-service`, `expo-battery`, `react-native-device-info`).
 *
 * NOTE: none of the behavior here is exercised by the Node domain tests; it is
 * validated on-device. The pure decision logic it delegates to
 * (`captureDeviceConfig`, `planBatteryOnboarding`, `planLostExecutionNotification`)
 * IS unit-tested.
 */
import {
  captureDeviceConfig,
  planLostExecutionNotification,
  type BatteryExemptionRequester,
  type DeviceBackgroundState,
  type DeviceBackgroundStateSource,
  type DeviceConfigSnapshot,
  type DevicePlatform,
  type ForegroundServiceController,
  type RestoreProtectionNotification,
  type RestoreProtectionNotifier,
} from "../domain/background-agent.js";

/**
 * Narrow shape of a native foreground-service module (e.g. Notifee /
 * `react-native-foreground-service`). Injected so this file has no hard import
 * on an optional native package.
 */
export interface NativeForegroundServiceModule {
  startService(config: { readonly channelId: string; readonly title: string }): Promise<void>;
  stopService(): Promise<void>;
  isRunning(): Promise<boolean>;
}

/** Build a {@link ForegroundServiceController} from a native FGS module (R18.1). */
export function makeForegroundServiceController(
  native: NativeForegroundServiceModule,
  config: { readonly channelId: string; readonly title: string } = {
    channelId: "kshema.ambient",
    title: "Kshema Ambient Shield",
  },
): ForegroundServiceController {
  return {
    async start() {
      await native.startService(config);
    },
    async stop() {
      await native.stopService();
    },
    async isActive() {
      return native.isRunning();
    },
  };
}

/**
 * Narrow shape of the native device-info surface the state source needs. A
 * dev/custom build maps these onto `react-native-device-info` / `expo-battery`
 * / `expo-application` (battery-optimization status is Android-only).
 */
export interface NativeDeviceInfoModule {
  getPlatform(): DevicePlatform;
  getManufacturer(): Promise<string | null>;
  /** Android: whether the app is ignoring battery optimizations. iOS: true. */
  isBatteryOptimizationExempt(): Promise<boolean>;
}

/**
 * Build a {@link DeviceBackgroundStateSource} (R18.5 inputs). The foreground
 * service controller supplies the live FGS-active flag.
 */
export function makeDeviceBackgroundStateSource(
  info: NativeDeviceInfoModule,
  foregroundService: ForegroundServiceController,
): DeviceBackgroundStateSource {
  return {
    async read(): Promise<DeviceBackgroundState> {
      const platform = info.getPlatform();
      return {
        platform,
        oem: await info.getManufacturer(),
        batteryExempt: await info.isBatteryOptimizationExempt(),
        foregroundServiceActive:
          platform === "ANDROID" ? await foregroundService.isActive() : false,
      };
    },
  };
}

/**
 * Narrow shape of the native battery-optimization intent launcher (Android
 * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). iOS builds return true.
 */
export interface NativeBatteryExemptionModule {
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
}

/** Build a {@link BatteryExemptionRequester} (R18.2). */
export function makeBatteryExemptionRequester(
  native: NativeBatteryExemptionModule,
): BatteryExemptionRequester {
  return {
    async request() {
      return native.requestIgnoreBatteryOptimizations();
    },
  };
}

/**
 * Narrow shape of a native local-notification module (e.g.
 * `expo-notifications`) used to surface the R18.4 restore-protection prompt.
 */
export interface NativeNotificationModule {
  present(notification: {
    readonly title: string;
    readonly body: string;
    readonly data?: Record<string, unknown>;
  }): Promise<void>;
}

/** Build a {@link RestoreProtectionNotifier} (R18.4). */
export function makeRestoreProtectionNotifier(
  native: NativeNotificationModule,
): RestoreProtectionNotifier {
  return {
    async notify(notification: RestoreProtectionNotification) {
      await native.present({
        title: "Restore Kshema protection",
        body: notification.suggestBatteryExemption
          ? "Ambient Shield stopped running in the background. Allow it to run without battery limits to stay protected."
          : "Ambient Shield stopped running in the background. Open Kshema to restore protection.",
        data: { kind: notification.kind },
      });
    },
  };
}

/**
 * On-device health tick: read live background state, capture a `DeviceConfig`
 * snapshot for fleet health (R18.5), and — if background execution has been
 * lost while protection is enabled — notify the Anchor to restore it (R18.4).
 * The pure decisions are delegated to the domain layer.
 */
export async function runBackgroundHealthTick(deps: {
  readonly stateSource: DeviceBackgroundStateSource;
  readonly notifier: RestoreProtectionNotifier;
  readonly protectionEnabled: boolean;
  readonly lastTelemetrySyncAt?: string;
}): Promise<DeviceConfigSnapshot> {
  const state = await deps.stateSource.read();
  const notification = planLostExecutionNotification(
    state,
    deps.protectionEnabled,
  );
  if (notification) {
    await deps.notifier.notify(notification);
  }
  return captureDeviceConfig(state, deps.lastTelemetrySyncAt);
}

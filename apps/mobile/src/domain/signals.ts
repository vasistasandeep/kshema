/**
 * Passive well-being signal + Ghost_Signal collection (R5.1, R5.2, R6.1-R6.3).
 *
 * The background agent observes ordinary device/household activity and turns it
 * into telemetry the API can ingest:
 *   - Passive signals (R5.1): screen-unlock events, step-count deltas, battery
 *     and charger state -> aggregated into a `Heartbeat` (R5.2).
 *   - Ghost signals (R6): a discovered household media device transitioning
 *     standby -> active (R6.2), and the Anchor device re-associating with the
 *     home Wi-Fi network after 05:00 local time (R6.3).
 *
 * This module holds the pure mapping/aggregation logic and the narrow platform
 * interfaces (device discovery, sensor sources) the Expo bindings implement.
 * There is deliberately NO location/GPS field anywhere here: passive telemetry
 * excludes continuous location trace by construction (R5.5, R19.1).
 */
import type { ChargerState, GhostSignal, Heartbeat } from "@kshema/types";

/**
 * The household media-device categories the discovery agent recognizes on the
 * local network (R6.1): Samsung Tizen TVs, Chromecast, FireTV, Roku.
 */
export const DISCOVERABLE_MEDIA_DEVICE_KINDS = [
  "TIZEN_TV",
  "CHROMECAST",
  "FIRE_TV",
  "ROKU",
] as const;
export type MediaDeviceKind = (typeof DISCOVERABLE_MEDIA_DEVICE_KINDS)[number];

/** Power state of a discovered media device. */
export type MediaDevicePowerState = "STANDBY" | "ACTIVE";

/** A household media device discovered on the local network (R6.1). */
export interface DiscoveredMediaDevice {
  readonly id: string;
  readonly kind: MediaDeviceKind;
  /** Human-friendly name, e.g. "Living Room TV". Never a location trace. */
  readonly friendlyName?: string;
  readonly powerState: MediaDevicePowerState;
}

/**
 * Discovery agent contract (mDNS/SSDP scan on the local network). The Expo
 * binding implements this over a native discovery module; tests inject a fake.
 */
export interface MediaDeviceDiscovery {
  /** Snapshot the currently discovered devices and their power states. */
  scan(): Promise<readonly DiscoveredMediaDevice[]>;
}

/** Raw passive-signal readings captured since the last heartbeat. */
export interface PassiveSignalReading {
  /** ISO timestamps of screen-unlock events observed this window (R5.1). */
  readonly screenUnlocks?: readonly string[];
  /** Step count delta since the last heartbeat (R5.1); clamped to >= 0. */
  readonly stepDelta?: number;
  /** Battery percentage 0..100 (R5.1). */
  readonly battery?: number;
  /** Charger state (R5.1). */
  readonly chargerState?: ChargerState;
}

/**
 * Sources the background agent reads passive signals from. Screen unlocks and
 * charger transitions arrive via broadcast receivers on Android; steps/battery
 * from the platform health/battery APIs.
 */
export interface PassiveSignalSource {
  drainSinceLastHeartbeat(): Promise<PassiveSignalReading>;
}

/**
 * Aggregate a passive-signal reading into a `Heartbeat` DTO (R5.2). Normalizes
 * a negative or missing step delta to 0 and always stamps `capturedAt`.
 */
export function buildHeartbeat(
  deviceId: string,
  reading: PassiveSignalReading,
  capturedAt: string,
): Heartbeat {
  const heartbeat: Heartbeat = {
    deviceId,
    screenUnlocks: reading.screenUnlocks ? [...reading.screenUnlocks] : [],
    stepDelta:
      typeof reading.stepDelta === "number" && reading.stepDelta > 0
        ? Math.floor(reading.stepDelta)
        : 0,
    capturedAt,
  };
  const withBattery =
    typeof reading.battery === "number"
      ? { ...heartbeat, battery: clampBattery(reading.battery) }
      : heartbeat;
  return reading.chargerState
    ? { ...withBattery, chargerState: reading.chargerState }
    : withBattery;
}

function clampBattery(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * A media device transitions standby -> active iff the previous power state was
 * STANDBY (or previously unseen) and the current state is ACTIVE (R6.2).
 */
export function isStandbyToActiveTransition(
  previous: MediaDevicePowerState | undefined,
  current: MediaDevicePowerState,
): boolean {
  return current === "ACTIVE" && previous !== "ACTIVE";
}

/**
 * Diff two discovery scans and emit a `MEDIA_DEVICE_WAKE` Ghost_Signal for each
 * device that woke from standby to active (R6.2). `source` records the device
 * kind + id so co-living household attribution can identify shared devices.
 */
export function detectMediaDeviceWakeSignals(
  previousScan: readonly DiscoveredMediaDevice[],
  currentScan: readonly DiscoveredMediaDevice[],
  detectedAt: string,
): GhostSignal[] {
  const previousById = new Map(previousScan.map((d) => [d.id, d.powerState]));
  const signals: GhostSignal[] = [];
  for (const device of currentScan) {
    if (isStandbyToActiveTransition(previousById.get(device.id), device.powerState)) {
      signals.push({
        signalType: "MEDIA_DEVICE_WAKE",
        source: `${device.kind}:${device.id}`,
        detectedAt,
      });
    }
  }
  return signals;
}

/** Local hour (0..23) after which a home-Wi-Fi re-association counts (R6.3). */
export const HOME_WIFI_REASSOCIATION_MIN_HOUR = 5;

/**
 * Whether a home-Wi-Fi re-association qualifies as a Ghost_Signal (R6.3): the
 * device must have re-associated with the *home* network SSID/BSSID and the
 * local time must be at or after 05:00. `localHour` is the Anchor-local hour of
 * `reassociatedAt` (the caller resolves the Anchor timezone). A re-association
 * before 05:00 (e.g. a nighttime blip) is intentionally excluded so it cannot
 * spuriously confirm the morning routine.
 */
export function qualifiesAsHomeWifiGhostSignal(params: {
  readonly isHomeNetwork: boolean;
  readonly localHour: number;
}): boolean {
  return params.isHomeNetwork && params.localHour >= HOME_WIFI_REASSOCIATION_MIN_HOUR;
}

/**
 * Build a `HOME_WIFI_REASSOCIATION` Ghost_Signal from a qualifying home-Wi-Fi
 * re-association (R6.3), or `null` when it does not qualify.
 */
export function buildHomeWifiGhostSignal(params: {
  readonly isHomeNetwork: boolean;
  readonly localHour: number;
  readonly detectedAt: string;
  readonly ssid?: string;
}): GhostSignal | null {
  if (!qualifiesAsHomeWifiGhostSignal(params)) return null;
  const signal: GhostSignal = {
    signalType: "HOME_WIFI_REASSOCIATION",
    detectedAt: params.detectedAt,
  };
  return params.ssid ? { ...signal, source: params.ssid } : signal;
}

/** Wi-Fi association state the agent inspects on a connectivity change. */
export interface WifiAssociation {
  readonly isHomeNetwork: boolean;
  readonly ssid?: string;
}

/** Source of the current Wi-Fi association (Android/iOS network APIs). */
export interface WifiAssociationSource {
  current(): Promise<WifiAssociation | null>;
}

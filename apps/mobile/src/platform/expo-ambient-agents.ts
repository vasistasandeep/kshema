/**
 * Expo/React Native platform bindings for the ambient agents of task 22.3:
 * Flight Recorder capture + upload, the acoustic classifier's native surfaces,
 * Shadow_SOS hardware triggers + Blackout_Mode, and the bedtime battery reader.
 *
 * Every native dependency is injected behind the narrow interface it satisfies
 * (the same style as `native-keygen.ts`), so this file has NO hard import on an
 * optional native package and the domain layer stays testable under Node. These
 * bindings are exercised only on device (Expo/EAS build) — they are outside the
 * Node CI typecheck graph (`tsconfig.domain.json` covers `src/domain` only).
 *
 * NOTE: the crypto for a black-box seal lives in `@kshema/encryption` and runs
 * in the domain layer; these bindings only supply the *inputs* (coarse location,
 * Wi-Fi, battery) and the *transports* (blackbox-sync upload, trigger-sos POST,
 * distilled-signal emit). No audio and no private key ever passes through here.
 */
import type {
  BlackBoxUploader,
  ContextSnapshot,
  SnapshotSource,
} from "../domain/flight-recorder.js";
import type {
  AcousticSignal,
  AcousticSignalSink,
} from "../domain/acoustic.js";
import type {
  ShadowSosDispatcher,
  ShadowSosTriggerKind,
} from "../domain/shadow-sos.js";
import type { EncryptedBlackBoxRecord } from "@kshema/encryption";
import type {
  BatteryReader,
  ChargerState,
} from "../domain/bedtime-guardian.js";

// --- Injected native surfaces (kept dependency-free at type level) ---

/** Coarse device readings the Flight Recorder snapshot is built from (R8.1). */
export interface DeviceContextReader {
  /** Coarse (low-accuracy) location, or null when permission is denied. */
  coarseLocation(): Promise<ContextSnapshot["coarseLocation"] | null>;
  /** Current Wi-Fi association label (SSID/BSSID), or null. */
  wifiAssociation(): Promise<string | null>;
  /** Battery level percentage [0,100] and charger state. */
  battery(): Promise<{ level: number; charger: ChargerState }>;
}

/** The minimal API-client surface these agents call. */
export interface AmbientApiClient {
  /** Server-blind blackbox-sync (R8.6). Body is the already-wrapped record. */
  postBlackBoxSync(record: EncryptedBlackBoxRecord): Promise<void>;
  /** Distilled acoustic signal (never audio — R10.2, R19.4). */
  postAcousticSignal(signal: AcousticSignal): Promise<void>;
  /** Silent Shadow_SOS trigger with decrypted location (R11.4–R11.6). */
  postTriggerSos(input: {
    kind: ShadowSosTriggerKind;
    triggeredAt: number;
    decryptedLocation: { lat: number; lon: number } | null;
  }): Promise<void>;
}

/** Build the Flight Recorder {@link SnapshotSource} from device readers (R8.1). */
export function makeExpoSnapshotSource(
  reader: DeviceContextReader,
): SnapshotSource {
  return {
    async capture(now: number): Promise<ContextSnapshot> {
      const [coarseLocation, wifi, battery] = await Promise.all([
        reader.coarseLocation(),
        reader.wifiAssociation(),
        reader.battery(),
      ]);
      return {
        capturedAt: now,
        ...(coarseLocation ? { coarseLocation } : {}),
        ...(wifi ? { wifiAssociation: wifi } : {}),
        batteryLevel: battery.level,
        chargerState: battery.charger,
      };
    },
  };
}

/** Build the {@link BlackBoxUploader} over the API client (R8.6). */
export function makeExpoBlackBoxUploader(
  api: AmbientApiClient,
): BlackBoxUploader {
  return {
    async upload(record: EncryptedBlackBoxRecord): Promise<void> {
      await api.postBlackBoxSync(record);
    },
  };
}

/** Build the acoustic {@link AcousticSignalSink} over the API client. */
export function makeExpoAcousticSink(api: AmbientApiClient): AcousticSignalSink {
  return {
    async emit(signal: AcousticSignal): Promise<void> {
      await api.postAcousticSignal(signal);
    },
  };
}

/**
 * Build the {@link ShadowSosDispatcher}. The Anchor's decrypted location is read
 * on trigger from the injected reader (R11.5) and sent to the API, which
 * releases black boxes to permitted Observers (R11.6). Silent — no UI here.
 */
export function makeExpoShadowSosDispatcher(
  api: AmbientApiClient,
  reader: Pick<DeviceContextReader, "coarseLocation">,
): ShadowSosDispatcher {
  return {
    async dispatch(input): Promise<void> {
      const loc = await reader.coarseLocation();
      await api.postTriggerSos({
        kind: input.kind,
        triggeredAt: input.triggeredAt,
        decryptedLocation: loc ? { lat: loc.lat, lon: loc.lon } : null,
      });
    },
  };
}

/** Build the bedtime {@link BatteryReader} from the device battery surface. */
export function makeExpoBatteryReader(
  reader: Pick<DeviceContextReader, "battery">,
): BatteryReader {
  return {
    async read() {
      try {
        const b = await reader.battery();
        return { batteryLevel: b.level, chargerState: b.charger };
      } catch {
        // Permission revoked / read failed: skip silently rather than emit a
        // false chime (design "Bedtime battery evaluation (R32)").
        return null;
      }
    },
  };
}

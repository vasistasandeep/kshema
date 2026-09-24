/**
 * Expo/React Native binding of the {@link BulkSyncTransport} contract
 * (R24.1, R24.2).
 *
 * Provides connectivity detection and the `POST /api/v1/telemetry/bulk-sync`
 * network call the Offline_Telemetry_Queue uses to flush on reconnect. The
 * connectivity source is INJECTED (a dev/custom build maps it onto
 * `@react-native-community/netinfo` or `expo-network`) so this file has no hard
 * dependency on an optional native package and the queue's flush logic stays
 * fully unit-tested in the domain layer. The API call itself uses the standard
 * `fetch` available in React Native.
 */
import type {
  BulkSync,
  BulkSyncResponse,
} from "@kshema/types";
import type { BulkSyncTransport } from "../domain/offline-queue.js";

/** Narrow connectivity probe (mapped onto NetInfo/expo-network on device). */
export interface ConnectivitySource {
  isConnected(): Promise<boolean>;
}

export interface BulkSyncTransportConfig {
  /** Base URL of the Kshema_API, e.g. `https://api.kshema.app`. */
  readonly apiBaseUrl: string;
  /** Returns the current bearer access token, or null when unauthenticated. */
  readonly getAccessToken: () => Promise<string | null> | string | null;
  readonly connectivity: ConnectivitySource;
  /** Injectable for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Raised when the bulk-sync endpoint returns a non-2xx status. */
export class BulkSyncHttpError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`bulk-sync failed with HTTP ${status}: ${body}`);
    this.name = "BulkSyncHttpError";
  }
}

/** Build the production {@link BulkSyncTransport}. */
export function makeExpoBulkSyncTransport(
  config: BulkSyncTransportConfig,
): BulkSyncTransport {
  const doFetch = config.fetchImpl ?? fetch;
  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/api/v1/telemetry/bulk-sync`;

  return {
    async isOnline() {
      return config.connectivity.isConnected();
    },
    async flush(payload: BulkSync): Promise<BulkSyncResponse> {
      const token = await config.getAccessToken();
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token) headers.authorization = `Bearer ${token}`;

      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new BulkSyncHttpError(res.status, body);
      }
      return (await res.json()) as BulkSyncResponse;
    },
  };
}

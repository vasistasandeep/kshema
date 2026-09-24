/**
 * Composition root for device-side dependencies.
 *
 * Wires the production Secure_Enclave and platform key store bindings and picks
 * the RSA-2048 generator. On device the native generator is used; if a native
 * RSA module has not been linked (e.g. running under Expo Go), we fall back to
 * the WebCrypto/Node generator so the identity flow still functions in
 * development. The private key produced here goes straight into the enclave and
 * is never returned to any API-bound value.
 */
import { makeExpoSecureEnclave } from "./platform/expo-secure-enclave.js";
import { makeExpoPlatformKeyStore } from "./platform/expo-platform-key-store.js";
import { nodeKeyPairGenerator, type KeyPairGenerator } from "./domain/keygen.js";
import type { SecureEnclave } from "./domain/secure-enclave.js";
import type { PlatformKeyStore } from "./domain/platform-key-store.js";
import type { IdentityDeps } from "./domain/identity.js";
import type { RecoveryDeps } from "./domain/key-recovery.js";

export const enclave: SecureEnclave = makeExpoSecureEnclave();
export const platformKeyStore: PlatformKeyStore = makeExpoPlatformKeyStore();

/**
 * The keygen used by the app. A custom/dev build swaps in
 * `makeNativeKeyPairGenerator(rsaModule)`; the fallback keeps the same
 * contract.
 */
export const keygen: KeyPairGenerator = nodeKeyPairGenerator;

export const identityDeps: IdentityDeps = { enclave, keygen };
export const recoveryDeps: RecoveryDeps = { enclave, keyStore: platformKeyStore };

// --- Background telemetry / ghost-signal / offline agents (task 22.2) ---
//
// The Offline_Telemetry_Queue is constructed per device once the deviceId and a
// bulk-sync transport are known. The transport and the background-agent native
// bindings depend on optional native modules (connectivity, foreground service,
// device-info, notifications) that a custom/dev client supplies, so they are
// wired at agent-start time rather than eagerly here.
export {
  OfflineTelemetryQueue,
  type BulkSyncTransport,
  type QueueStore,
} from "./domain/offline-queue.js";
export {
  makeExpoBulkSyncTransport,
  type BulkSyncTransportConfig,
} from "./platform/expo-bulk-sync-transport.js";
export { runBackgroundHealthTick } from "./platform/expo-background-agent.js";

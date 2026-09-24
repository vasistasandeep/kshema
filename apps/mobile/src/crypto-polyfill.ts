/**
 * React Native crypto polyfill (loaded before any app code).
 *
 * The shared `@kshema/encryption` package is the single source of truth for the
 * zero-knowledge envelope (AES-256-GCM + RSA-OAEP-SHA256 + gzip). It is written
 * against Node's built-in `crypto`/`zlib` and the `Buffer` global so the same
 * code runs in `apps/api`, `apps/worker`, and the browser `Web_Crypto_Vault`.
 *
 * React Native's Hermes engine ships none of those. Rather than fork the crypto
 * into a second, RN-only implementation (which would be a correctness and audit
 * hazard for a safety product), we install a native drop-in here:
 *
 *   - `react-native-quick-crypto` provides a C/C++ JSI implementation of Node's
 *     `crypto` (real AES-GCM + RSA-OAEP), aliased for `node:crypto`/`crypto` in
 *     `metro.config.js`;
 *   - `@craftzdog/react-native-buffer` provides the `Buffer` global;
 *   - `browserify-zlib` (aliased for `node:zlib`/`zlib`) provides gzip.
 *
 * This file only installs the globals; the aliasing happens in Metro. Because
 * quick-crypto is a native module, it is present in EAS / dev-client builds
 * (the app's real distribution model — see the mobile README) and is not
 * available under Expo Go.
 */
import { Buffer } from "@craftzdog/react-native-buffer";
import { install } from "react-native-quick-crypto";

// `Buffer` is referenced by the shared envelope code (Buffer.from/concat/etc.).
if (typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}

// Install quick-crypto as `global.crypto` so anything reaching for the Web
// Crypto surface (and the Metro-aliased `node:crypto`) resolves to the native
// implementation.
install();

/**
 * Minimal `node:zlib` shim for React Native, aliased in `metro.config.js`.
 *
 * The shared `@kshema/encryption` envelope only ever calls `gzipSync` and
 * `gunzipSync` (to compress/decompress the Flight Recorder payload). Rather
 * than pull in `browserify-zlib` (which drags in `assert`, `stream`, and a
 * deep Node-internals chain), we implement exactly those two functions over
 * `pako` — the same pure-JS zlib `browserify-zlib` uses under the hood. pako
 * produces standard gzip framing, so a payload compressed here is readable by
 * Node's `zlib` on the api/worker/web side and vice-versa.
 *
 * Buffers are Uint8Array subclasses, so wrapping pako's Uint8Array output in
 * `Buffer.from` keeps the envelope's `Buffer` return contract intact.
 */
import { gzip, ungzip } from "pako";

export function gzipSync(data: Uint8Array | string): Buffer {
  return Buffer.from(gzip(data));
}

export function gunzipSync(data: Uint8Array): Buffer {
  return Buffer.from(ungzip(data));
}

// Node's zlib is imported as a namespace (`import { gzipSync } from "node:zlib"`),
// so a default export mirroring the module shape keeps both import styles working.
export default { gzipSync, gunzipSync };

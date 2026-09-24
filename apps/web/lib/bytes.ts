/**
 * Byte / base64 helpers shared by the Web_Crypto_Vault and WebAuthn flows.
 *
 * These are pure and framework-agnostic so they can be unit-tested in Node
 * (Node 20+ provides `atob`/`btoa` and `globalThis.crypto.subtle`).
 */

/** Encode raw bytes to a standard base64 string. */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i] as number);
  }
  return btoa(binary);
}

/** Decode a standard base64 string to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** base64url (no padding) → bytes, used by WebAuthn challenges. */
export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(padded);
}

/**
 * Copy a byte view into a fresh standalone `ArrayBuffer`. WebCrypto / WebAuthn
 * DOM types require `BufferSource` backed by a plain `ArrayBuffer` (not the
 * `ArrayBufferLike` union a `Uint8Array` may carry), so callers pass values
 * through this to satisfy the lib.dom typings safely.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** bytes → base64url (no padding). */
export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

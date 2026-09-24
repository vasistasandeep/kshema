/**
 * Web_Crypto_Vault (R28.2, R28.3).
 *
 * The Observer's asymmetric key pair is generated or restored ENTIRELY in the
 * browser using the W3C Web Cryptography API (`crypto.subtle`). The private
 * key is created as a NON-EXTRACTABLE `CryptoKey` — the platform physically
 * refuses to export it — so it can never be serialized, logged, or transmitted
 * (R28.2). Only the exported PUBLIC key (SPKI PEM) is ever sent to the API,
 * for black-box key wrapping.
 *
 * The envelope this vault decrypts is produced by `@kshema/encryption`:
 *
 *   plaintext = gzip(JSON.stringify(payload))
 *   symKey    = 256-bit AES key                      (fresh, per payload)
 *   iv        = 96-bit GCM nonce
 *   {ct, tag} = AES-256-GCM(symKey, iv, plaintext)
 *   wrapped   = RSA-OAEP(SHA-256)(observerPublicKey, symKey)
 *
 * So decryption in the browser is: RSA-OAEP unwrap the AES key with the
 * non-extractable private key, AES-256-GCM decrypt (WebCrypto expects the tag
 * appended to the ciphertext), then gunzip + JSON.parse. Decrypted plaintext
 * stays in the local browser session and is NEVER transmitted back to the API
 * (R28.3).
 */
import type { BlackBoxCiphertext } from "@kshema/types";
import { base64ToBytes, bytesToBase64 } from "./bytes";

const RSA_MODULUS_BITS = 2048;
const RSA_PUB_EXPONENT = new Uint8Array([0x01, 0x00, 0x01]); // 65537
const HASH = "SHA-256" as const;

/** IndexedDB coordinates for the persisted (non-extractable) private key. */
const DB_NAME = "kshema-web-crypto-vault";
const STORE = "keys";
const PRIVATE_KEY_ID = "observer-private-key";

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("Web Cryptography API is unavailable in this environment.");
  }
  return c.subtle;
}

/** An Observer key pair. The private half is a non-extractable handle only. */
export interface VaultKeyPair {
  /** SPKI PEM of the public key — the ONLY half that ever leaves the browser. */
  readonly publicKeyPem: string;
  /** Non-extractable private-key handle. Cannot be serialized or transmitted. */
  readonly privateKey: CryptoKey;
}

/* ----------------------------------------------------------- key material -- */

/**
 * Generate a fresh Observer RSA-OAEP key pair. The private key is created with
 * `extractable = false`, so `crypto.subtle.exportKey` on it will REJECT — the
 * key can only ever be used for `unwrapKey`/`decrypt`, never exported (R28.2).
 */
export async function generateVaultKeyPair(): Promise<VaultKeyPair> {
  const pair = await subtle().generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: RSA_MODULUS_BITS,
      publicExponent: RSA_PUB_EXPONENT,
      hash: HASH,
    },
    /* extractable */ false,
    ["decrypt", "unwrapKey"],
  );
  // The public key is extractable (default); export + PEM-encode it.
  const spki = await subtle().exportKey("spki", pair.publicKey);
  return {
    publicKeyPem: spkiToPem(spki),
    privateKey: pair.privateKey,
  };
}

/** Assert the private key genuinely refuses export (defence-in-depth). */
export async function assertPrivateKeyNonExtractable(
  privateKey: CryptoKey,
): Promise<void> {
  if (privateKey.extractable) {
    throw new Error("Vault invariant violated: private key is extractable.");
  }
  try {
    await subtle().exportKey("pkcs8", privateKey);
  } catch {
    return; // expected: export rejected
  }
  throw new Error("Vault invariant violated: private key export did not fail.");
}

/* ---------------------------------------------------------------- persistence
 * A non-extractable `CryptoKey` can itself be stored in IndexedDB (structured
 * clone preserves the opaque handle) WITHOUT ever exposing key bytes. This lets
 * a returning Observer restore the same key pair across sessions on the same
 * device without the private key material ever being readable.
 */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this environment."));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

async function idbGet(key: string): Promise<CryptoKey | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(key: string, value: CryptoKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Restore the existing vault key pair from device storage, or generate a fresh
 * one and persist the non-extractable private-key handle (R28.2). Returns the
 * public PEM to register with the API on first use.
 */
export async function loadOrCreateVault(): Promise<VaultKeyPair> {
  const existing = await idbGet(PRIVATE_KEY_ID).catch(() => undefined);
  if (existing) {
    const spki = await derivePublicSpkiFromStored(existing);
    if (spki) return { publicKeyPem: spkiToPem(spki), privateKey: existing };
  }
  const pair = await generateVaultKeyPair();
  await idbPut(PRIVATE_KEY_ID, pair.privateKey).catch(() => undefined);
  // Store the public PEM alongside so we can hand it back without re-deriving.
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(`${DB_NAME}.pub`, pair.publicKeyPem);
  }
  return pair;
}

/**
 * The public key cannot be re-derived from a non-extractable private handle, so
 * we cache the PEM in localStorage at creation time and read it back here.
 */
async function derivePublicSpkiFromStored(
  _privateKey: CryptoKey,
): Promise<ArrayBuffer | undefined> {
  if (typeof localStorage === "undefined") return undefined;
  const pem = localStorage.getItem(`${DB_NAME}.pub`);
  if (!pem) return undefined;
  return pemToSpki(pem);
}

/* --------------------------------------------------------------- decryption */

/**
 * Decrypt a RELEASED black box entirely in-browser and return the parsed
 * Flight Recorder payload. The decrypted plaintext is a local value only and
 * is NEVER sent back to the API (R28.3).
 *
 * @throws if the GCM tag fails (tamper / wrong key) or the payload is malformed.
 */
export async function decryptBlackBoxInBrowser(
  box: BlackBoxCiphertext,
  privateKey: CryptoKey,
): Promise<unknown> {
  const wrappedKey = base64ToBytes(box.wrappedKey);
  const iv = base64ToBytes(box.iv);
  const ciphertext = base64ToBytes(box.encryptedPayload);
  const authTag = base64ToBytes(box.authTag);

  // 1. RSA-OAEP unwrap the per-payload AES-256-GCM key.
  const symKey = await subtle().unwrapKey(
    "raw",
    toArrayBuffer(wrappedKey),
    privateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["decrypt"],
  );

  // 2. AES-256-GCM decrypt. WebCrypto expects the tag appended to ciphertext.
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);

  let plaintextGz: ArrayBuffer;
  try {
    plaintextGz = await subtle().decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), tagLength: 128 },
      symKey,
      toArrayBuffer(combined),
    );
  } catch (cause) {
    throw new DecryptionIntegrityError(
      "Black-box integrity check failed (tampered payload or wrong key).",
      cause,
    );
  }

  // 3. gunzip + JSON.parse (mirrors `serializePayload` in @kshema/encryption).
  const json = await gunzipToString(new Uint8Array(plaintextGz));
  return JSON.parse(json) as unknown;
}

/** Thrown when a black box fails GCM integrity verification. */
export class DecryptionIntegrityError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DecryptionIntegrityError";
    this.cause = cause;
  }
}

/* ------------------------------------------------------------------ helpers */

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Decompress gzip bytes to a UTF-8 string using the browser's streams API. */
async function gunzipToString(gz: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream (gzip) is unavailable.");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([toArrayBuffer(gz)]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buf);
}

const PEM_HEADER = "-----BEGIN PUBLIC KEY-----";
const PEM_FOOTER = "-----END PUBLIC KEY-----";

/** SPKI DER → PEM (`-----BEGIN PUBLIC KEY-----`), matching Node SPKI PEM. */
export function spkiToPem(spki: ArrayBuffer): string {
  const b64 = bytesToBase64(spki);
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `${PEM_HEADER}\n${lines.join("\n")}\n${PEM_FOOTER}\n`;
}

/** PEM public key → SPKI DER bytes. */
export function pemToSpki(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(PEM_HEADER, "")
    .replace(PEM_FOOTER, "")
    .replace(/\s+/g, "");
  return toArrayBuffer(base64ToBytes(b64));
}

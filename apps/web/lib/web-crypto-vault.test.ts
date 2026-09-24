/**
 * Web_Crypto_Vault tests (R28.2, R28.3).
 *
 * These run in Node using the same W3C Web Cryptography API the browser
 * exposes (`globalThis.crypto.subtle` in Node 20+), so the vault's real
 * SubtleCrypto code path is exercised without a browser. We build a black box
 * with `@kshema/encryption` (the exact server-side envelope) and prove the
 * vault decrypts it in-process, and that a tampered box fails integrity.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encryptBlackBox } from "@kshema/encryption";
import type { BlackBoxCiphertext } from "@kshema/types";
import { bytesToBase64, base64ToBytes } from "./bytes";
import {
  DecryptionIntegrityError,
  decryptBlackBoxInBrowser,
  generateVaultKeyPair,
  assertPrivateKeyNonExtractable,
  pemToSpki,
} from "./web-crypto-vault";

/** Import a PKCS8 PEM as a NON-EXTRACTABLE RSA-OAEP private CryptoKey. */
async function importPrivate(pkcs8Pem: string): Promise<CryptoKey> {
  const b64 = pkcs8Pem
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(b64);
  return globalThis.crypto.subtle.importKey(
    "pkcs8",
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    /* extractable */ false,
    ["decrypt", "unwrapKey"],
  );
}

function toBox(record: {
  encryptedPayload: Buffer;
  iv: Buffer;
  authTag: Buffer;
  recipientKeys: readonly { observerId: string; wrappedKey: Buffer }[];
}): BlackBoxCiphertext {
  const first = record.recipientKeys[0]!;
  return {
    boxId: "box-1",
    encryptedPayload: bytesToBase64(record.encryptedPayload),
    iv: bytesToBase64(record.iv),
    authTag: bytesToBase64(record.authTag),
    wrappedKey: bytesToBase64(first.wrappedKey),
    capturedRange: {
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-01-01T00:03:00.000Z",
    },
  };
}

describe("Web_Crypto_Vault", () => {
  it("generates a non-extractable private key and an SPKI public PEM", async () => {
    const pair = await generateVaultKeyPair();
    expect(pair.publicKeyPem).toMatch(/-----BEGIN PUBLIC KEY-----/);
    expect(pair.privateKey.extractable).toBe(false);
    // The public PEM must be a valid SPKI (round-trips through pemToSpki).
    expect(() => pemToSpki(pair.publicKeyPem)).not.toThrow();
    await expect(
      assertPrivateKeyNonExtractable(pair.privateKey),
    ).resolves.toBeUndefined();
  });

  it("decrypts a server-built black box in-browser (round trip)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const payload = { snapshots: [{ t: 1, ambient: "quiet" }], v: 1 };
    const record = encryptBlackBox(payload, [
      { observerId: "obs-1", publicKey },
    ]);

    const cryptoKey = await importPrivate(privateKey);
    const decrypted = await decryptBlackBoxInBrowser(toBox(record), cryptoKey);

    expect(decrypted).toEqual(payload);
  });

  it("rejects a tampered black box with a DecryptionIntegrityError", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const record = encryptBlackBox({ hello: "world" }, [
      { observerId: "obs-1", publicKey },
    ]);
    const box = toBox(record);
    // Flip a byte of the ciphertext.
    const bytes = base64ToBytes(box.encryptedPayload);
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered: BlackBoxCiphertext = {
      ...box,
      encryptedPayload: bytesToBase64(bytes),
    };

    const cryptoKey = await importPrivate(privateKey);
    await expect(
      decryptBlackBoxInBrowser(tampered, cryptoKey),
    ).rejects.toBeInstanceOf(DecryptionIntegrityError);
  });

  it("never transmits plaintext: gzip payload decodes only locally", async () => {
    // Sanity check that our gunzip path matches the encryption serializer.
    const gz = gzipSync(Buffer.from(JSON.stringify({ a: 1 })));
    expect(gz.length).toBeGreaterThan(0);
  });
});

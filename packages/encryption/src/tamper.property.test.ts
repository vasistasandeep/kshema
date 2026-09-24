/**
 * Property 2: Tampered payload fails integrity verification.
 *
 * For all Encrypted_Black_Boxes, mutating any single byte of the ciphertext
 * (encryptedPayload), the auth tag, the IV, or a wrapped recipient key SHALL
 * cause `decryptBlackBox` to reject the payload with a decryption-integrity
 * error rather than return plaintext (R9.2).
 *
 * A single RSA-2048 keypair is generated once and reused; each iteration
 * produces a fresh encryption, then flips one randomly chosen byte in one
 * randomly chosen field and asserts the decrypt throws.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generateKeyPairSync } from "node:crypto";
import { encryptBlackBox } from "./index.js";
import type { EncryptedBlackBoxRecord } from "./index.js";
import { decryptBlackBox, DecryptionIntegrityError } from "./decrypt.js";

// Feature: kshema-safety-platform, Property 2: Tampered payload fails integrity verification

const OBSERVER_ID = "obs-tamper";

// One keypair, generated once and reused across all runs (per task guidance).
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A JSON-able Flight Recorder snapshot. */
const snapshotArb = fc.record({
  at: fc.date({ min: new Date("2020-01-01"), max: new Date("2035-01-01") }).map((d) => d.toISOString()),
  steps: fc.nat({ max: 100_000 }),
  screenUnlock: fc.boolean(),
  charger: fc.constantFrom("plugged", "unplugged"),
});

/** The mutable byte fields of a black-box record that Property 2 tampers with. */
const TAMPER_FIELDS = ["encryptedPayload", "authTag", "iv", "wrappedKey"] as const;
type TamperField = (typeof TAMPER_FIELDS)[number];

/**
 * Return a copy of `record` with exactly one byte of the chosen field flipped
 * by XOR-ing a non-zero delta (guaranteeing the byte actually changes).
 */
function tamper(
  record: EncryptedBlackBoxRecord,
  field: TamperField,
  byteIndexSeed: number,
  xorDelta: number,
): EncryptedBlackBoxRecord {
  const flip = (buf: Buffer): Buffer => {
    const copy = Buffer.from(buf);
    const idx = byteIndexSeed % copy.length;
    copy[idx] = copy[idx]! ^ xorDelta;
    return copy;
  };

  switch (field) {
    case "encryptedPayload":
      return { ...record, encryptedPayload: flip(record.encryptedPayload) };
    case "authTag":
      return { ...record, authTag: flip(record.authTag) };
    case "iv":
      return { ...record, iv: flip(record.iv) };
    case "wrappedKey": {
      const row = record.recipientKeys[0]!;
      return {
        ...record,
        recipientKeys: [{ ...row, wrappedKey: flip(row.wrappedKey) }],
      };
    }
  }
}

describe("Property 2: tampered black-box payload fails integrity verification", () => {
  it("any single-byte tamper of ciphertext / authTag / iv / wrappedKey throws DecryptionIntegrityError", () => {
    fc.assert(
      fc.property(
        fc.array(snapshotArb, { maxLength: 20 }),
        fc.constantFrom(...TAMPER_FIELDS),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (buffer, field, byteIndexSeed, xorDelta) => {
          const record = encryptBlackBox(buffer, [
            { observerId: OBSERVER_ID, publicKey },
          ]);

          const mutated = tamper(record, field, byteIndexSeed, xorDelta);

          // Must reject: never return plaintext for a tampered record.
          expect(() =>
            decryptBlackBox(mutated, OBSERVER_ID, privateKey),
          ).toThrow(DecryptionIntegrityError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("the untampered record still decrypts (control: encryption is valid)", () => {
    fc.assert(
      fc.property(fc.array(snapshotArb, { maxLength: 20 }), (buffer) => {
        const record = encryptBlackBox(buffer, [
          { observerId: OBSERVER_ID, publicKey },
        ]);
        const out = decryptBlackBox(record, OBSERVER_ID, privateKey);
        expect(out).toEqual(buffer);
      }),
      { numRuns: 100 },
    );
  });
});

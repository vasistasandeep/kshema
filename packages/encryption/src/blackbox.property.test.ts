// Feature: kshema-safety-platform, Property 1
/**
 * Property 1: Black-box round-trip reproduces snapshots.
 *
 * *For all* valid rolling buffers (0–20 context snapshots) and any generated
 * RSA-2048 keypair, serializing, compressing, and encrypting the buffer into an
 * Encrypted_Black_Box and then decrypting it with the authorized private key
 * SHALL yield context snapshots deep-equal to the original buffer.
 *
 * This suite extends the design's single-keypair statement to the fan-out case
 * exercised by `encryptBlackBox`: for an arbitrary SET of authorized Observers
 * (each with its own RSA-2048 keypair), decrypting with ANY one authorized
 * Observer's private key reproduces the original snapshot buffer exactly.
 *
 * Performance note: RSA-2048 keypair generation is slow, so a fixed pool of
 * keypairs is generated ONCE and reused across fast-check iterations. Each
 * iteration still varies the payload and the selection of authorized Observers
 * (a subset of the pool) plus which authorized Observer performs the decrypt,
 * so "any generated RSA-2048 keypair" is covered by the pool while iteration
 * cost stays bounded.
 *
 * Validates: Requirements 8.10, 9.1
 */
import { describe, it } from "vitest";
import fc from "fast-check";
import { generateKeyPairSync } from "node:crypto";
import { encryptBlackBox } from "./index.js";
import { decryptBlackBox } from "./decrypt.js";

/** Generate one PEM-encoded RSA-2048 keypair (SPKI public / PKCS8 private). */
function rsaPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

// A fixed pool of distinct RSA-2048 keypairs, generated once and reused across
// all iterations. Size 4 gives enough distinct observers to exercise fan-out
// and arbitrary authorized-observer subsets without per-iteration keygen cost.
const KEYPAIR_POOL = Array.from({ length: 4 }, () => rsaPair());

/**
 * Arbitrary for a single Flight Recorder context snapshot. Kept JSON-able so it
 * survives the `gzip(JSON.stringify(...))` serialization in the envelope, and
 * shaped loosely like the real rolling-buffer entries (timestamp + ambient
 * telemetry) while still spanning nested/optional structure.
 */
const snapshotArb = fc.record(
  {
    at: fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2035-01-01T00:00:00Z") }).map((d) => d.toISOString()),
    steps: fc.integer({ min: 0, max: 50_000 }),
    screenUnlock: fc.boolean(),
    charger: fc.option(fc.constantFrom("plugged", "unplugged"), { nil: undefined }),
    battery: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
    note: fc.option(fc.string(), { nil: undefined }),
    tags: fc.array(fc.string(), { maxLength: 5 }),
  },
  { requiredKeys: ["at", "steps", "screenUnlock", "tags"] },
);

/** A rolling buffer of 0–20 context snapshots (design generator, maxLength 20). */
const bufferArb = fc.array(snapshotArb, { maxLength: 20 });

describe("Property 1: black-box round-trip reproduces snapshots", () => {
  it("encrypt-then-decrypt with any authorized Observer's key is identity over the buffer", () => {
    fc.assert(
      fc.property(
        bufferArb,
        // Choose a non-empty subset of the keypair pool as authorized Observers,
        // then pick which of those authorized Observers performs the decrypt.
        fc
          .subarray(
            KEYPAIR_POOL.map((_, idx) => idx),
            { minLength: 1 },
          )
          .chain((observerIdxs) =>
            fc.record({
              observerIdxs: fc.constant(observerIdxs),
              decryptWith: fc.constantFrom(...observerIdxs),
            }),
          ),
        (buffer, { observerIdxs, decryptWith }) => {
          const observerPublicKeys = observerIdxs.map((idx) => ({
            observerId: `obs-${idx}`,
            publicKey: KEYPAIR_POOL[idx]!.publicKey,
          }));

          const record = encryptBlackBox(buffer, observerPublicKeys);

          // Any authorized Observer's private key reproduces the original buffer.
          const roundTripped = decryptBlackBox(
            record,
            `obs-${decryptWith}`,
            KEYPAIR_POOL[decryptWith]!.privateKey,
          );

          // Deep-equal fidelity: fast-check throws with a counterexample on mismatch.
          return JSON.stringify(roundTripped) === JSON.stringify(buffer);
        },
      ),
      { numRuns: 100 },
    );
  });
});

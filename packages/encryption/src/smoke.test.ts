/**
 * Internal smoke test for the envelope primitives. This is NOT the property
 * suite — Properties 1 & 2 are implemented in tasks 2.2 / 2.3. These cases just
 * confirm the round-trip, fan-out, tamper-rejection, recovery-backup, and
 * dossier-escrow paths wire together on real Node crypto.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  encryptBlackBox,
  encryptEmergencyDossier,
  createRecoveryBackup,
  restoreFromRecoveryBackup,
  DecryptionIntegrityError,
} from "./index.js";
import {
  decryptBlackBox,
  decryptEmergencyDossier,
  NoRecipientKeyError,
} from "./decrypt.js";

function rsaPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const snapshots = [
  { at: "2025-01-01T05:30:00Z", steps: 12, screenUnlock: true },
  { at: "2025-01-01T05:33:00Z", steps: 40, charger: "unplugged" },
];

describe("encryptBlackBox / decryptBlackBox", () => {
  it("round-trips a rolling buffer for an authorized Observer", () => {
    const obs = rsaPair();
    const record = encryptBlackBox(snapshots, [
      { observerId: "obs-1", publicKey: obs.publicKey },
    ]);

    expect(record.iv).toHaveLength(12);
    expect(record.authTag).toHaveLength(16);
    expect(record.recipientKeys).toHaveLength(1);

    const out = decryptBlackBox(record, "obs-1", obs.privateKey);
    expect(out).toEqual(snapshots);
  });

  it("fans out one wrapped key per Observer; each unwraps independently", () => {
    const a = rsaPair();
    const b = rsaPair();
    const record = encryptBlackBox(snapshots, [
      { observerId: "obs-a", publicKey: a.publicKey },
      { observerId: "obs-b", publicKey: b.publicKey },
    ]);
    expect(record.recipientKeys.map((r) => r.observerId)).toEqual([
      "obs-a",
      "obs-b",
    ]);
    expect(decryptBlackBox(record, "obs-a", a.privateKey)).toEqual(snapshots);
    expect(decryptBlackBox(record, "obs-b", b.privateKey)).toEqual(snapshots);
  });

  it("raises DecryptionIntegrityError on a tampered ciphertext (GCM tag)", () => {
    const obs = rsaPair();
    const record = encryptBlackBox(snapshots, [
      { observerId: "obs-1", publicKey: obs.publicKey },
    ]);
    const tampered = Buffer.from(record.encryptedPayload);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() =>
      decryptBlackBox(
        { ...record, encryptedPayload: tampered },
        "obs-1",
        obs.privateKey,
      ),
    ).toThrow(DecryptionIntegrityError);
  });

  it("rejects an Observer with no matching recipient-key row", () => {
    const obs = rsaPair();
    const record = encryptBlackBox(snapshots, [
      { observerId: "obs-1", publicKey: obs.publicKey },
    ]);
    expect(() => decryptBlackBox(record, "stranger", obs.privateKey)).toThrow(
      NoRecipientKeyError,
    );
  });

  it("rejects duplicate observerIds in the fan-out list", () => {
    const obs = rsaPair();
    expect(() =>
      encryptBlackBox(snapshots, [
        { observerId: "dup", publicKey: obs.publicKey },
        { observerId: "dup", publicKey: obs.publicKey },
      ]),
    ).toThrow(RangeError);
  });
});

describe("emergency dossier envelope (break-glass escrow)", () => {
  it("round-trips via the escrowed circle emergency key", () => {
    const emergency = rsaPair();
    const dossier = { bloodGroup: "O+", allergies: ["penicillin"] };
    const record = encryptEmergencyDossier(dossier, emergency.publicKey);
    const out = decryptEmergencyDossier(record, emergency.privateKey);
    expect(out).toEqual(dossier);
  });
});

describe("Argon2id recovery backup", () => {
  it("restores a private key with the correct passphrase", async () => {
    const { privateKey } = rsaPair();
    const backup = await createRecoveryBackup(privateKey, "correct horse battery");
    const restored = await restoreFromRecoveryBackup(backup, "correct horse battery");
    expect(restored).toBe(privateKey);
  });

  it("fails to restore with a wrong passphrase", async () => {
    const { privateKey } = rsaPair();
    const backup = await createRecoveryBackup(privateKey, "right-pass");
    await expect(
      restoreFromRecoveryBackup(backup, "wrong-pass"),
    ).rejects.toBeInstanceOf(DecryptionIntegrityError);
  });
});

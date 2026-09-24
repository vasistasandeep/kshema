import { describe, expect, it } from "vitest";
import {
  buildRegistration,
  createIdentity,
  getPublicKeyPem,
  hasIdentity,
  PrivateKeyLeakError,
} from "./identity.js";
import { nodeKeyPairGenerator, isPrivateKeyPem, isPublicKeyPem } from "./keygen.js";
import { ENCLAVE_KEYS, createInMemoryEnclave } from "./secure-enclave.js";

function deps() {
  return { enclave: createInMemoryEnclave(), keygen: nodeKeyPairGenerator };
}

describe("createIdentity (R1.4, R1.5, R1.8)", () => {
  it("generates an RSA-2048 key pair and stores the private key in the enclave", async () => {
    const d = deps();
    const result = await createIdentity(d);

    expect(isPublicKeyPem(result.publicKeyPem)).toBe(true);
    const storedPrivate = await d.enclave.getItem(ENCLAVE_KEYS.privateKeyPem);
    expect(storedPrivate).not.toBeNull();
    expect(isPrivateKeyPem(storedPrivate as string)).toBe(true);
    expect(await hasIdentity(d)).toBe(true);
  });

  it("returns ONLY the public key in the API registration payload (R1.8)", async () => {
    const d = deps();
    const { registration } = await createIdentity(d);

    expect(isPublicKeyPem(registration.clientPublicKeyPem)).toBe(true);
    // The registration object must not carry any private-key material.
    const serialized = JSON.stringify(registration);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(Object.keys(registration)).toEqual(["clientPublicKeyPem"]);
  });

  it("caches the public key in the enclave for later re-registration", async () => {
    const d = deps();
    const { publicKeyPem } = await createIdentity(d);
    expect(await getPublicKeyPem(d)).toBe(publicKeyPem);
  });
});

describe("buildRegistration guard (R1.8)", () => {
  it("rejects a private key masquerading as a registration payload", async () => {
    const { privateKeyPem } = await nodeKeyPairGenerator.generateRsaKeyPair();
    expect(() => buildRegistration(privateKeyPem)).toThrow(PrivateKeyLeakError);
  });

  it("rejects non-key strings", () => {
    expect(() => buildRegistration("not a key")).toThrow(PrivateKeyLeakError);
  });

  it("accepts a genuine public key PEM", async () => {
    const { publicKeyPem } = await nodeKeyPairGenerator.generateRsaKeyPair();
    expect(buildRegistration(publicKeyPem)).toEqual({
      clientPublicKeyPem: publicKeyPem,
    });
  });
});

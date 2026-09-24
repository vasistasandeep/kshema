/**
 * WebAuthn passkey-ceremony integration tests (R28.1, task 24.2 / 25.4).
 *
 * `createPasskey`/`assertPasskey` are thin wrappers over
 * `navigator.credentials.{create,get}` that shape the browser response into
 * the API's strict `@kshema/types` DTOs. They run browser-only, so here we
 * stub a minimal `navigator.credentials` + `PublicKeyCredential` and prove:
 *   - the assertion DTO carries the signature COUNTER decoded big-endian from
 *     `authenticatorData` bytes 33..36 (the value the server clone-checks),
 *   - a non-increasing counter is faithfully reported to the server (the
 *     client never masks it; the server enforces the rejection — R28.1),
 *   - the shaped DTOs satisfy the strict schemas (no stray field), and
 *   - a cancelled ceremony surfaces as an error rather than a silent success.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebAuthnAuthenticateVerifySchema,
  WebAuthnRegisterVerifySchema,
  type WebAuthnAuthenticateOptionsResponse,
  type WebAuthnRegisterOptionsResponse,
} from "@kshema/types";
import { bytesToBase64Url } from "./bytes";
import { assertPasskey, createPasskey } from "./webauthn";

/** Build 37-byte authenticatorData whose bytes 33..36 encode `counter` (BE). */
function authDataWithCounter(counter: number): Uint8Array {
  const data = new Uint8Array(37);
  // bytes 0..31 rpIdHash, 32 flags — left zeroed; 33..36 signCount big-endian.
  data[33] = (counter >>> 24) & 0xff;
  data[34] = (counter >>> 16) & 0xff;
  data[35] = (counter >>> 8) & 0xff;
  data[36] = counter & 0xff;
  return data;
}

function bufOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Install a stub browser WebAuthn surface returning `credential`. */
function stubCredentials(credential: unknown, method: "create" | "get") {
  const create = vi.fn(async () => credential);
  const get = vi.fn(async () => credential);
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", { credentials: { create, get } });
  return method === "create" ? create : get;
}

const REGISTER_OPTIONS: WebAuthnRegisterOptionsResponse = {
  challenge: bytesToBase64Url(new Uint8Array([1, 2, 3, 4])),
  rpId: "kshema.app",
  rpName: "Kshema",
  userId: "user-1",
  userName: "+919876543210",
  timeoutMs: 60_000,
  attestation: "none",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

const AUTH_OPTIONS: WebAuthnAuthenticateOptionsResponse = {
  challenge: bytesToBase64Url(new Uint8Array([9, 9, 9, 9])),
  rpId: "kshema.app",
  timeoutMs: 60_000,
  allowCredentials: [
    { id: bytesToBase64Url(new Uint8Array([7, 7])), type: "public-key", transports: ["internal"] },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createPasskey — registration ceremony (R28.1)", () => {
  it("shapes navigator.credentials.create() into a strict register DTO", async () => {
    const create = stubCredentials(
      {
        rawId: bufOf(new Uint8Array([10, 11, 12])),
        response: {
          getPublicKey: () => bufOf(new Uint8Array([20, 21, 22])),
          getTransports: () => ["internal", "hybrid"],
          attestationObject: bufOf(new Uint8Array([30, 31])),
        },
      },
      "create",
    );

    const dto = await createPasskey(REGISTER_OPTIONS);

    expect(create).toHaveBeenCalledOnce();
    // The shaped DTO must satisfy the strict schema exactly (no extra fields).
    expect(() => WebAuthnRegisterVerifySchema.parse(dto)).not.toThrow();
    expect(dto.transports).toEqual(["internal", "hybrid"]);
  });

  it("throws when the authenticator cancels registration", async () => {
    stubCredentials(null, "create");
    await expect(createPasskey(REGISTER_OPTIONS)).rejects.toThrow(/cancelled/i);
  });
});

describe("assertPasskey — authentication ceremony (R28.1)", () => {
  it("decodes the signature counter big-endian from authenticatorData 33..36", async () => {
    const counter = 0x01020304; // 16909060
    stubCredentials(
      {
        rawId: bufOf(new Uint8Array([1, 2])),
        response: {
          signature: bufOf(new Uint8Array([40, 41])),
          authenticatorData: bufOf(authDataWithCounter(counter)),
          clientDataJSON: bufOf(new TextEncoder().encode("{}")),
        },
      },
      "get",
    );

    const dto = await assertPasskey(AUTH_OPTIONS);

    expect(dto.counter).toBe(counter);
    expect(() => WebAuthnAuthenticateVerifySchema.parse(dto)).not.toThrow();
  });

  it("faithfully reports a NON-INCREASING counter for the server clone-check (R28.1)", async () => {
    // A cloned/rolled-back authenticator presents a stale (or zero) counter.
    // The client must NOT mask it — it reports exactly what the authenticator
    // returned so the server can reject a non-increasing value.
    const previouslySeen = 42;
    const staleCounter = 7; // lower than what the server last stored

    stubCredentials(
      {
        rawId: bufOf(new Uint8Array([1, 2])),
        response: {
          signature: bufOf(new Uint8Array([1])),
          authenticatorData: bufOf(authDataWithCounter(staleCounter)),
          clientDataJSON: bufOf(new TextEncoder().encode("{}")),
        },
      },
      "get",
    );

    const dto = await assertPasskey(AUTH_OPTIONS);

    expect(dto.counter).toBe(staleCounter);
    // Modelling the server-side clone-check: a non-increasing counter is
    // rejected. The client's job is only to report the true value.
    const rejectedByServer = dto.counter <= previouslySeen;
    expect(rejectedByServer).toBe(true);
  });

  it("reads a zero counter when authenticatorData is too short", async () => {
    stubCredentials(
      {
        rawId: bufOf(new Uint8Array([1])),
        response: {
          signature: bufOf(new Uint8Array([1])),
          authenticatorData: bufOf(new Uint8Array(10)), // < 37 bytes
          clientDataJSON: bufOf(new TextEncoder().encode("{}")),
        },
      },
      "get",
    );

    const dto = await assertPasskey(AUTH_OPTIONS);
    expect(dto.counter).toBe(0);
  });

  it("throws when the authenticator cancels authentication", async () => {
    stubCredentials(null, "get");
    await expect(assertPasskey(AUTH_OPTIONS)).rejects.toThrow(/cancelled/i);
  });
});

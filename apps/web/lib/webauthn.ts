/**
 * WebAuthn passkey ceremonies for the Observer web portal (R28.1).
 *
 * FIDO2 / TouchID / Windows Hello passkeys are an OPTIONAL second factor for
 * subsequent logins. Each ceremony has an `.../options` call (server mints a
 * single-use challenge) followed by `navigator.credentials.{create,get}` in
 * the browser, then a `.../verify` call. No private key ever leaves the
 * authenticator; only the attestation/assertion material is transmitted.
 *
 * These wrappers are browser-only (they call `navigator.credentials`). They
 * are isolated here so the rest of the auth flow stays testable in Node.
 */
import type {
  WebAuthnAuthenticateOptionsResponse,
  WebAuthnAuthenticateVerify,
  WebAuthnRegisterOptionsResponse,
  WebAuthnRegisterVerify,
} from "@kshema/types";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  toArrayBuffer,
} from "./bytes";

/** True when this browser exposes the WebAuthn API. */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials
  );
}

/**
 * Run `navigator.credentials.create()` for a registration ceremony and shape
 * the browser response into the API's `WebAuthnRegisterVerify` DTO.
 */
export async function createPasskey(
  options: WebAuthnRegisterOptionsResponse,
): Promise<WebAuthnRegisterVerify> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toArrayBuffer(base64UrlToBytes(options.challenge)),
      rp: { id: options.rpId, name: options.rpName },
      user: {
        id: toArrayBuffer(new TextEncoder().encode(options.userId)),
        name: options.userName,
        displayName: options.userName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeoutMs,
      attestation: options.attestation,
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey creation was cancelled.");
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === "function"
      ? response.getTransports()
      : [];

  return {
    credentialId: bytesToBase64Url(credential.rawId),
    publicKey: bytesToBase64(response.getPublicKey() ?? new ArrayBuffer(0)),
    transports,
    attestation: bytesToBase64(response.attestationObject),
  };
}

/**
 * Run `navigator.credentials.get()` for an authentication ceremony and shape
 * the browser response into the API's `WebAuthnAuthenticateVerify` DTO.
 */
export async function assertPasskey(
  options: WebAuthnAuthenticateOptionsResponse,
): Promise<WebAuthnAuthenticateVerify> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toArrayBuffer(base64UrlToBytes(options.challenge)),
      rpId: options.rpId,
      timeout: options.timeoutMs,
      allowCredentials: options.allowCredentials.map((c) => ({
        id: toArrayBuffer(base64UrlToBytes(c.id)),
        type: c.type,
        transports: c.transports as AuthenticatorTransport[],
      })),
      userVerification: "preferred",
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey authentication was cancelled.");
  }
  const response = credential.response as AuthenticatorAssertionResponse;

  // The signature counter is carried in authenticatorData bytes 33..36 (big
  // endian). The server enforces the non-decreasing-counter clone check.
  const authData = new Uint8Array(response.authenticatorData);
  const counter =
    authData.length >= 37
      ? ((authData[33] as number) << 24) |
        ((authData[34] as number) << 16) |
        ((authData[35] as number) << 8) |
        (authData[36] as number)
      : 0;

  return {
    credentialId: bytesToBase64Url(credential.rawId),
    signature: bytesToBase64(response.signature),
    authenticatorData: bytesToBase64(response.authenticatorData),
    clientDataJSON: bytesToBase64(response.clientDataJSON),
    counter: counter >>> 0,
  };
}

export { base64ToBytes };

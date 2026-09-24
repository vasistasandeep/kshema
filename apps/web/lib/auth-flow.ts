/**
 * Login orchestration for the Observer web portal (R28.1, R28.2).
 *
 * OTP login is the primary channel; a WebAuthn passkey is an optional second
 * factor for subsequent logins. On OTP verify we hand the API the PUBLIC key
 * from the Web_Crypto_Vault — never the private key (R28.2). The private key is
 * generated/restored locally and its non-extractability is asserted before the
 * public half is transmitted.
 */
import { requestOtp, verifyOtp } from "./api-client";
import { setSession } from "./session";
import {
  assertPrivateKeyNonExtractable,
  loadOrCreateVault,
  type VaultKeyPair,
} from "./web-crypto-vault";

export interface OtpLoginResult {
  /** The restored/created vault key pair for this session. */
  vault: VaultKeyPair;
}

/** Step 1: request an OTP to the registered phone number. */
export async function beginOtpLogin(phone: string): Promise<string> {
  const { challengeId } = await requestOtp(phone);
  return challengeId;
}

/**
 * Step 2: verify the OTP. Restores/creates the Web_Crypto_Vault, asserts the
 * private key is non-extractable, then verifies with ONLY the public PEM. On
 * success the JWT session is stored for this tab.
 */
export async function completeOtpLogin(
  challengeId: string,
  code: string,
): Promise<OtpLoginResult> {
  const vault = await loadOrCreateVault();
  await assertPrivateKeyNonExtractable(vault.privateKey);

  const session = await verifyOtp({
    challengeId,
    code,
    clientPublicKeyPem: vault.publicKeyPem,
  });
  setSession(session);
  return { vault };
}

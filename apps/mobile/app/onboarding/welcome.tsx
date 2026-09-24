import { useState } from "react";
import { useRouter } from "expo-router";
import { Body, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import { createIdentity } from "../../src/domain/identity";
import { identityDeps } from "../../src/runtime";
import { useSessionStore } from "../../src/stores/hooks";

/**
 * Welcome + identity bootstrap. Generating the RSA-2048 key pair (R1.4) and
 * seating the private key in the Secure_Enclave (R1.8) happens here; the
 * returned public-key registration payload is what the verify step sends to the
 * API (R1.5). We never place the private key in the store.
 */
export default function Welcome() {
  const router = useRouter();
  const markIdentityCreated = useSessionStore((s) => s.markIdentityCreated);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    try {
      // Generate identity now so the public key is ready for OTP verify.
      await createIdentity(identityDeps);
      markIdentityCreated();
      router.push("/onboarding/verify");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Welcome to Kshema</Title>
      <Body>
        Kshema helps your Circle share peace of mind through gentle, private
        signals — never intrusive watching. We will first create a private
        security key that stays on this device.
      </Body>
      <PrimaryButton
        label={busy ? "Preparing your key…" : "Get started"}
        onPress={begin}
        disabled={busy}
      />
    </Screen>
  );
}

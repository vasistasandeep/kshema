import { useState } from "react";
import { TextInput } from "react-native";
import { useRouter } from "expo-router";
import { Body, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import { useSessionStore } from "../../src/stores/hooks";

/**
 * OTP verification (R1.1–R1.3). This shell collects the phone/OTP and, on a
 * successful verify, stores the returned {@link AuthSession}. The verify request
 * carries only the client PUBLIC key (built by `buildRegistration`) — never the
 * private key (R1.5, R1.8). Network wiring to `/api/v1/auth/otp/*` lands with
 * the API client task; here we model the successful outcome.
 */
export default function Verify() {
  const router = useRouter();
  const setSession = useSessionStore((s) => s.setSession);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");

  function verify() {
    // Placeholder session; replaced by the real OTP verify response.
    setSession({
      userId: "pending",
      accessToken: "pending",
      refreshToken: "pending",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    router.replace("/onboarding/disclaimer");
  }

  return (
    <Screen>
      <Title>Verify your number</Title>
      <Body>We will send a one-time passcode to confirm it is you.</Body>
      <TextInput
        className="rounded-xl border border-temple-brass/40 px-4 py-3 text-typography"
        placeholder="Phone number"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
      />
      <TextInput
        className="rounded-xl border border-temple-brass/40 px-4 py-3 text-typography"
        placeholder="Passcode"
        keyboardType="number-pad"
        value={code}
        onChangeText={setCode}
      />
      <PrimaryButton label="Verify" onPress={verify} disabled={code.length < 4} />
    </Screen>
  );
}

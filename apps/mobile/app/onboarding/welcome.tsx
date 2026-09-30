import { useState } from "react";
import { useRouter } from "expo-router";
import { Body, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import { createIdentity } from "../../src/domain/identity";
import { identityDeps } from "../../src/runtime";
import { useSessionStore } from "../../src/stores/hooks";
import { connectLiveAsAnchor, connectLiveAsObserver } from "../../src/live-connect";

/**
 * Welcome + identity bootstrap (R1.4, R1.8). Also offers a "Connect to my
 * Circle" action that logs into the live backend and opens the Observer
 * dashboard with real data — the end-to-end device path.
 */
export default function Welcome() {
  const router = useRouter();
  const markIdentityCreated = useSessionStore((s) => s.markIdentityCreated);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setBusy(true);
    try {
      await createIdentity(identityDeps);
      markIdentityCreated();
      router.push("/onboarding/verify");
    } finally {
      setBusy(false);
    }
  }

  async function connectLive() {
    setConnecting(true); setError(null);
    try {
      await connectLiveAsObserver();
      router.replace("/(app)/observer");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setConnecting(false);
    }
  }

  async function connectAnchor() {
    setConnecting(true); setError(null);
    try {
      await connectLiveAsAnchor();
      router.replace("/(app)/anchor");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setConnecting(false);
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
        disabled={busy || connecting}
      />
      <PrimaryButton
        label={connecting ? "Connecting…" : "Connect to my Circle (live)"}
        onPress={connectLive}
        disabled={busy || connecting}
      />
      <PrimaryButton
        label={connecting ? "Connecting…" : "Enter as Anchor (live)"}
        onPress={connectAnchor}
        disabled={busy || connecting}
      />
      {error ? <Body>{"Could not connect: " + error}</Body> : null}
    </Screen>
  );
}

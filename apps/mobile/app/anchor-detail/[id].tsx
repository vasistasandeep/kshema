import { useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Body, Card, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import { fetchBlackBox, type BlackBoxCiphertext } from "../../src/api-client";

/**
 * Anchor detail + Flight Recorder (Observer drill-down). Reached by tapping an
 * Anchor on the Observer dashboard. The "Request black box" action calls the
 * gated anchor-scoped endpoint; access control (CircleMember + canAccessBlackBox
 * + released Stage-4/Shadow_SOS) is enforced server-side. This surface reflects
 * the gate decision and shows ciphertext metadata only — real decryption would
 * happen in the on-device vault with the Observer private key.
 */
export default function AnchorDetail() {
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const router = useRouter();
  const anchorId = String(params.id ?? "");
  const name = params.name ? String(params.name) : "Anchor";

  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState<BlackBoxCiphertext | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  async function requestBox() {
    setBusy(true); setBox(null); setDenied(null);
    try {
      const r = await fetchBlackBox(anchorId);
      if (r.ok) setBox(r.box);
      else setDenied(r.message);
    } catch (e) {
      setDenied(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>{name}</Title>

      <Card>
        <Text className="text-base font-semibold text-typography">Flight Recorder</Text>
        <Body>
          The encrypted black box can only be opened during a real emergency, and
          only by an authorized guardian. Our servers can never read it.
        </Body>
        <PrimaryButton
          label={busy ? "Requesting…" : "Request black box"}
          onPress={requestBox}
          disabled={busy}
        />
      </Card>

      {box ? (
        <Card>
          <Text className="text-base font-semibold text-healthy">Access granted</Text>
          <Body>The server released ciphertext to you (decryption would happen on-device).</Body>
          <View className="gap-1">
            <Text className="text-xs text-typography/60">box: {box.boxId}</Text>
            <Text className="text-xs text-typography/60">
              range: {new Date(box.capturedRange.start).toLocaleString()} → {new Date(box.capturedRange.end).toLocaleString()}
            </Text>
            <Text className="text-xs text-typography/60" numberOfLines={1}>
              payload: {box.encryptedPayload.slice(0, 40)}…
            </Text>
            <Text className="text-xs text-typography/60" numberOfLines={1}>
              your wrapped key: {box.wrappedKey.slice(0, 40)}…
            </Text>
          </View>
        </Card>
      ) : null}

      {denied ? (
        <Card>
          <Text className="text-base font-semibold text-escalating">Access denied</Text>
          <Body>{denied}</Body>
        </Card>
      ) : null}

      <PrimaryButton label="Back to Circle" onPress={() => router.back()} />
    </Screen>
  );
}

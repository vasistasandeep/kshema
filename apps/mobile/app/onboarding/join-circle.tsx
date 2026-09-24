import { useState } from "react";
import { TextInput } from "react-native";
import { useRouter } from "expo-router";
import {
  Body,
  Card,
  PrimaryButton,
  Screen,
  Title,
} from "../../src/components/primitives";
import { useMembershipStore } from "../../src/stores/hooks";
import type { CircleRole } from "@kshema/types";

/**
 * Join or create a Circle (R2). This shell captures an invite token + role and
 * records the resulting membership; the API wiring lands with the circles
 * client task. The chosen role drives which surfaces the app mounts (R2.6).
 */
export default function JoinCircle() {
  const router = useRouter();
  const addMembership = useMembershipStore((s) => s.addMembership);
  const [token, setToken] = useState("");
  const [role, setRole] = useState<CircleRole>("OBSERVER");

  function join() {
    addMembership({
      circleId: "pending",
      circleName: "My Circle",
      member: {
        memberId: "pending",
        userId: "pending",
        role,
        canTriggerIVR: false,
        canAccessBlackBox: role !== "ANCHOR",
      },
    });
    router.replace("/(app)");
  }

  return (
    <Screen>
      <Title>Join your Circle</Title>
      <Body>Enter the invitation your family shared with you.</Body>
      <TextInput
        className="rounded-xl border border-temple-brass/40 px-4 py-3 text-typography"
        placeholder="Invitation code"
        value={token}
        onChangeText={setToken}
        autoCapitalize="characters"
      />
      <Card>
        <Body>Your role in this Circle</Body>
        {(["ANCHOR", "OBSERVER", "MUTUAL"] as const).map((r) => (
          <PrimaryButton
            key={r}
            label={role === r ? `● ${label(r)}` : label(r)}
            onPress={() => setRole(r)}
          />
        ))}
      </Card>
      <PrimaryButton label="Join Circle" onPress={join} disabled={token.length < 3} />
    </Screen>
  );
}

function label(role: CircleRole): string {
  switch (role) {
    case "ANCHOR":
      return "Anchor — I am cared for";
    case "OBSERVER":
      return "Observer — I care for someone";
    case "MUTUAL":
      return "Mutual — both";
  }
}

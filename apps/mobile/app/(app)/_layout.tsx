import { Tabs } from "expo-router";
import { semanticColors } from "@kshema/ui";
import { useMembershipStore } from "../../src/stores/hooks";
import {
  showsAnchorSurface,
  showsObserverSurface,
} from "../../src/domain/roles";

/**
 * Role-based surface router (R2.6). A single dynamic tab set renders the Anchor
 * home and/or the Observer dashboard depending on the active Circle role:
 * ANCHOR → anchor only, OBSERVER → observer only, MUTUAL → both. Tabs are
 * hidden (not just disabled) for surfaces that do not apply to the role.
 */
export default function AppLayout() {
  const role = useMembershipStore((s) => s.activeRole());

  const anchor = role ? showsAnchorSurface(role) : false;
  const observer = role ? showsObserverSurface(role) : false;

  return (
    <Tabs
      sceneContainerStyle={{ backgroundColor: semanticColors.canvas }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: semanticColors.primaryAction,
        tabBarInactiveTintColor: semanticColors.typography,
      }}
    >
      <Tabs.Screen
        name="anchor"
        options={{ title: "Home", href: anchor ? "/(app)/anchor" : null }}
      />
      <Tabs.Screen
        name="observer"
        options={{ title: "Circle", href: observer ? "/(app)/observer" : null }}
      />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}

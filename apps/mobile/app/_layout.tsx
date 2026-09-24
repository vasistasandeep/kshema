// Crypto polyfill MUST be the first import so the Buffer/crypto globals are
// installed before any module that pulls in `@kshema/encryption` evaluates.
import "../src/crypto-polyfill";
import "../global.css";

import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { semanticColors } from "@kshema/ui";
import { resolveOnboardingRoute } from "../src/domain/roles";
import { useSessionStore } from "../src/stores/hooks";
import { useMembershipStore } from "../src/stores/hooks";

/**
 * Root layout. Establishes the SafeArea + brand canvas and runs the onboarding
 * guard: on every navigation it resolves where the user should be from the
 * session/membership stores and redirects if they are off-path. This is what
 * enforces the disclaimer gate (R26.2) and the preferred-name prompt before
 * joining a Circle (R1.7) at the navigation layer.
 */
export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();

  const hasIdentity = useSessionStore((s) => s.hasIdentity);
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated());
  const needsPreferredName = useSessionStore((s) => s.needsPreferredName());
  const canActivateShield = useSessionStore((s) => s.canActivateShield());
  const hasCircle = useMembershipStore((s) => s.hasCircle());

  useEffect(() => {
    const target = resolveOnboardingRoute({
      hasIdentity,
      hasSession: isAuthenticated,
      hasPreferredName: !needsPreferredName,
      disclaimerAccepted: canActivateShield,
      hasCircle,
    });
    const current = `/${segments.join("/")}`;
    const inApp = segments[0] === "(app)";
    const wantsApp = target === "/(app)";
    // Only redirect when we are clearly on the wrong side of the funnel.
    if (wantsApp && !inApp) {
      router.replace("/(app)");
    } else if (!wantsApp && current !== target && !inApp) {
      router.replace(target);
    }
  }, [
    hasIdentity,
    isAuthenticated,
    needsPreferredName,
    canActivateShield,
    hasCircle,
    segments,
    router,
  ]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: semanticColors.canvas },
        }}
      >
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(app)" />
      </Stack>
    </SafeAreaProvider>
  );
}

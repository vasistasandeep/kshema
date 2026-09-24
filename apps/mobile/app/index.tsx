import { Redirect } from "expo-router";
import { resolveOnboardingRoute } from "../src/domain/roles";
import { useSessionStore } from "../src/stores/hooks";
import { useMembershipStore } from "../src/stores/hooks";

/**
 * Entry route. Resolves the correct starting point from the current
 * onboarding/session state and redirects there — the disclaimer gate (R26.2)
 * and preferred-name prompt (R1.7) are enforced by this resolution.
 */
export default function Index() {
  const hasIdentity = useSessionStore((s) => s.hasIdentity);
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated());
  const needsPreferredName = useSessionStore((s) => s.needsPreferredName());
  const canActivateShield = useSessionStore((s) => s.canActivateShield());
  const hasCircle = useMembershipStore((s) => s.hasCircle());

  const target = resolveOnboardingRoute({
    hasIdentity,
    hasSession: isAuthenticated,
    hasPreferredName: !needsPreferredName,
    disclaimerAccepted: canActivateShield,
    hasCircle,
  });

  return <Redirect href={target} />;
}

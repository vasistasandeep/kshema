import { Redirect } from "expo-router";
import { useMembershipStore } from "../../src/stores/hooks";
import { showsAnchorSurface } from "../../src/domain/roles";

/**
 * Default landing screen for the (app) group. Navigating to the bare group
 * path `/(app)` (from the root guard or the onboarding funnel) has no screen
 * to match on its own — a Tabs navigator needs a concrete initial route — so
 * this index resolves the active Circle role and redirects to the matching
 * surface (R2.6). ANCHOR/MUTUAL land on the Anchor home; OBSERVER lands on the
 * Observer dashboard. With no role yet, default to the Observer surface.
 */
export default function AppIndex() {
  const role = useMembershipStore((s) => s.activeRole());
  const toAnchor = role ? showsAnchorSurface(role) : false;
  return <Redirect href={toAnchor ? "/(app)/anchor" : "/(app)/observer"} />;
}

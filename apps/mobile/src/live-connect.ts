/**
 * Live backend connection bootstrap.
 *
 * Runs the real end-to-end flow against the Fastify API: dev login (mints a
 * session), load the Observer dashboard into the dashboard store, and seed a
 * membership so the role-based tabs render. Used by the welcome screen's
 * "Connect to my Circle" action for a working device demo.
 */
import type { AnchorWellBeing, CircleMember } from "@kshema/types";
import { devLogin, fetchDashboard, getCurrentUserId, sendHeartbeat } from "./api-client";
import { useSessionStore, useMembershipStore, useDashboardStore } from "./stores/hooks";

export interface LiveConnectResult {
  userId: string;
  anchors: AnchorWellBeing[];
}

/**
 * Connect to the live backend as an Observer. Defaults to the seeded demo
 * observer so the dashboard has data immediately; a real onboarding would pass
 * the user's own verified phone + generated public key.
 */
export async function connectLiveAsObserver(
  phone = "+919000000002",
  preferredName = "Ravi",
): Promise<LiveConnectResult> {
  const login = await devLogin(phone, preferredName);

  // Reflect the authenticated session in the store (R1).
  const nowIso = new Date().toISOString();
  useSessionStore.getState().setSession({
    userId: login.userId,
    accessToken: login.accessToken,
    refreshToken: login.accessToken,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  useSessionStore.getState().markIdentityCreated();
  useSessionStore.getState().setPreferredName(preferredName);

  // Seed an Observer membership so the (app) tabs mount the Circle surface (R2.6).
  const member: CircleMember = {
    id: "self",
    userId: login.userId,
    role: "OBSERVER",
    canTriggerIVR: true,
    canAccessBlackBox: true,
  } as unknown as CircleMember;
  useMembershipStore.getState().setMemberships([
    { circleId: "live", circleName: "My Circle", member },
  ]);

  // Load the live dashboard (R15).
  const dash = await fetchDashboard();
  useDashboardStore.getState().setAnchors(dash.anchors);
  useDashboardStore.getState().markRefreshed(nowIso);

  return { userId: login.userId, anchors: dash.anchors };
}

/** Refresh the Observer dashboard from the API. */
export async function refreshDashboard(): Promise<void> {
  const dash = await fetchDashboard();
  useDashboardStore.getState().setAnchors(dash.anchors);
  useDashboardStore.getState().markRefreshed(new Date().toISOString());
}

/** Send a confirming heartbeat (as an Anchor would) ? proves telemetry ingest. */
export async function confirmImWell(): Promise<void> {
  if (!getCurrentUserId()) return;
  await sendHeartbeat({ screenUnlock: true, stepDelta: 25, batteryPercent: 82 });
}

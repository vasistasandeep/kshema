/**
 * Live backend connection bootstrap.
 *
 * Runs the real end-to-end flow against the Fastify API. Two entry points:
 *   - connectLiveAsObserver: dev login as the seeded Observer, load the
 *     Observer dashboard into the store, seed an Observer membership.
 *   - connectLiveAsAnchor: dev login as the seeded Anchor so a heartbeat from
 *     this device targets this Anchor own open incident (R13.1/R13.2).
 */
import type { AnchorWellBeing, CircleMember } from "@kshema/types";
import { devLogin, fetchDashboard, getCurrentUserId, sendHeartbeat } from "./api-client";
import { useSessionStore, useMembershipStore, useDashboardStore } from "./stores/hooks";

export interface LiveConnectResult {
  userId: string;
  anchors: AnchorWellBeing[];
}

export async function connectLiveAsObserver(
  phone = "+919000000002",
  preferredName = "Ravi",
): Promise<LiveConnectResult> {
  const login = await devLogin(phone, preferredName);

  const nowIso = new Date().toISOString();
  useSessionStore.getState().setSession({
    userId: login.userId,
    accessToken: login.accessToken,
    refreshToken: login.accessToken,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  useSessionStore.getState().markIdentityCreated();
  useSessionStore.getState().setPreferredName(preferredName);

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

  const dash = await fetchDashboard();
  useDashboardStore.getState().setAnchors(dash.anchors);
  useDashboardStore.getState().markRefreshed(nowIso);

  return { userId: login.userId, anchors: dash.anchors };
}

export async function connectLiveAsAnchor(
  phone = "+919000000001",
  preferredName = "Amma",
): Promise<string> {
  const login = await devLogin(phone, preferredName);
  useSessionStore.getState().setSession({
    userId: login.userId,
    accessToken: login.accessToken,
    refreshToken: login.accessToken,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  useSessionStore.getState().markIdentityCreated();
  useSessionStore.getState().setPreferredName(preferredName);

  const member: CircleMember = {
    id: "self",
    userId: login.userId,
    role: "ANCHOR",
    canTriggerIVR: false,
    canAccessBlackBox: false,
  } as unknown as CircleMember;
  useMembershipStore.getState().setMemberships([
    { circleId: "live", circleName: "My Circle", member },
  ]);

  return login.userId;
}

export async function refreshDashboard(): Promise<void> {
  const dash = await fetchDashboard();
  useDashboardStore.getState().setAnchors(dash.anchors);
  useDashboardStore.getState().markRefreshed(new Date().toISOString());
}

export async function confirmImWell(): Promise<boolean> {
  if (!getCurrentUserId()) return false;
  const ack = await sendHeartbeat({ screenUnlock: true, stepDelta: 25, battery: 82 });
  return ack !== null;
}

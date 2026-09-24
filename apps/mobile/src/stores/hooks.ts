/**
 * Zustand store hooks (React binding layer).
 *
 * These wrap the framework-agnostic slice creators from this folder with
 * zustand's `create()` so screens can subscribe. This file imports `zustand`
 * and is therefore part of the RN app typecheck (`typecheck:app`) — it is
 * excluded from the Node domain typecheck, which verifies the slice logic
 * directly via `createTestStore`.
 */
import { create } from "zustand";
import { createSessionSlice, type SessionState } from "./session-slice.js";
import {
  createMembershipSlice,
  type MembershipState,
} from "./membership-slice.js";
import { createPolicySlice, type PolicyState } from "./policy-slice.js";
import {
  createDashboardSlice,
  type DashboardState,
} from "./dashboard-slice.js";

/** Session/identity/disclaimer store (R1, R26). */
export const useSessionStore = create<SessionState>((set, get) =>
  createSessionSlice(set, get),
);

/** Circle membership store; drives role-based surface routing (R2). */
export const useMembershipStore = create<MembershipState>((set, get) =>
  createMembershipSlice(set, get),
);

/** Sentinel Persona_Mode policy store (R3). */
export const usePolicyStore = create<PolicyState>((set, get) =>
  createPolicySlice(set, get),
);

/** Observer dashboard store (R15). */
export const useDashboardStore = create<DashboardState>((set, get) =>
  createDashboardSlice(set, get),
);

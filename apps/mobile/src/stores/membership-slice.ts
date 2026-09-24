/**
 * Membership store (R2).
 *
 * Holds the Circles the user belongs to and the currently active Circle. The
 * active member's role drives which surfaces the router mounts (R2.6), exposed
 * through `activeRole` / `surfaces` selectors.
 */
import type { CircleMember, CircleRole } from "@kshema/types";
import { surfacesForRole, type Surface } from "../domain/roles.js";
import type { GetState, SetState, SliceCreator } from "./slice.js";

/** A Circle the user is a member of, plus this user's membership record. */
export interface Membership {
  readonly circleId: string;
  readonly circleName: string;
  readonly member: CircleMember;
}

export interface MembershipState {
  memberships: Membership[];
  activeCircleId: string | null;

  // actions
  setMemberships: (memberships: Membership[]) => void;
  addMembership: (membership: Membership) => void;
  setActiveCircle: (circleId: string) => void;
  clear: () => void;

  // selectors
  hasCircle: () => boolean;
  activeMembership: () => Membership | null;
  activeRole: () => CircleRole | null;
  surfaces: () => Surface[];
}

export const createMembershipSlice: SliceCreator<MembershipState> = (
  set: SetState<MembershipState>,
  get: GetState<MembershipState>,
) => ({
  memberships: [],
  activeCircleId: null,

  setMemberships: (memberships) =>
    set((state) => ({
      memberships,
      // keep the active circle if still present, else default to the first.
      activeCircleId:
        memberships.find((m) => m.circleId === state.activeCircleId)?.circleId ??
        memberships[0]?.circleId ??
        null,
    })),
  addMembership: (membership) =>
    set((state) => {
      const memberships = [
        ...state.memberships.filter((m) => m.circleId !== membership.circleId),
        membership,
      ];
      return {
        memberships,
        activeCircleId: state.activeCircleId ?? membership.circleId,
      };
    }),
  setActiveCircle: (circleId) => set({ activeCircleId: circleId }),
  clear: () => set({ memberships: [], activeCircleId: null }),

  hasCircle: () => get().memberships.length > 0,
  activeMembership: () => {
    const { memberships, activeCircleId } = get();
    return memberships.find((m) => m.circleId === activeCircleId) ?? null;
  },
  activeRole: () => get().activeMembership()?.member.role ?? null,
  surfaces: () => {
    const role = get().activeRole();
    return role ? surfacesForRole(role) : [];
  },
});

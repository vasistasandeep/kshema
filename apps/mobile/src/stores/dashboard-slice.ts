/**
 * Dashboard store (R15).
 *
 * Holds the Observer dashboard view — per-Anchor derived well-being state only.
 * By construction it carries no continuous location trace (R15.5, R19.1); the
 * shape comes straight from `@kshema/types` `AnchorWellBeing`, whose schema
 * forbids location fields.
 */
import type { AnchorWellBeing } from "@kshema/types";
import type { GetState, SetState, SliceCreator } from "./slice.js";

export interface DashboardState {
  anchors: AnchorWellBeing[];
  /** Last successful dashboard refresh (ISO-8601), or null. */
  lastRefreshedAt: string | null;

  // actions
  setAnchors: (anchors: AnchorWellBeing[]) => void;
  upsertAnchor: (anchor: AnchorWellBeing) => void;
  markRefreshed: (at: string) => void;
  clear: () => void;

  // selectors
  anchorById: (anchorId: string) => AnchorWellBeing | null;
  /** Anchors currently in an escalating state (Amber on the dashboard). */
  escalatingAnchors: () => AnchorWellBeing[];
}

export const createDashboardSlice: SliceCreator<DashboardState> = (
  set: SetState<DashboardState>,
  get: GetState<DashboardState>,
) => ({
  anchors: [],
  lastRefreshedAt: null,

  setAnchors: (anchors) => set({ anchors }),
  upsertAnchor: (anchor) =>
    set((state) => ({
      anchors: [
        ...state.anchors.filter((a) => a.anchorId !== anchor.anchorId),
        anchor,
      ],
    })),
  markRefreshed: (at) => set({ lastRefreshedAt: at }),
  clear: () => set({ anchors: [], lastRefreshedAt: null }),

  anchorById: (anchorId) =>
    get().anchors.find((a) => a.anchorId === anchorId) ?? null,
  escalatingAnchors: () =>
    get().anchors.filter((a) => a.state === "ESCALATING"),
});

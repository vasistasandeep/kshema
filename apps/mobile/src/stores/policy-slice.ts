/**
 * Sentinel policy store (R3).
 *
 * Holds the active Persona_Modes for the current Anchor. Multiple modes may be
 * active concurrently (R3.9); when none is selected the app applies
 * Elderly_Care as the default (R3.2).
 */
import type { SentinelMode } from "@kshema/types";
import type { GetState, SetState, SliceCreator } from "./slice.js";

/** Default Persona_Mode applied when none is selected (R3.2). */
export const DEFAULT_PERSONA_MODE: SentinelMode = "ELDERLY_CARE";

export interface PolicyState {
  /** Explicitly selected Persona_Modes (may be empty). */
  selectedModes: SentinelMode[];

  // actions
  setModes: (modes: SentinelMode[]) => void;
  toggleMode: (mode: SentinelMode) => void;
  reset: () => void;

  // selectors
  /** Effective modes: the selection, or [Elderly_Care] when empty (R3.2). */
  activeModes: () => SentinelMode[];
  isModeActive: (mode: SentinelMode) => boolean;
}

export const createPolicySlice: SliceCreator<PolicyState> = (
  set: SetState<PolicyState>,
  get: GetState<PolicyState>,
) => ({
  selectedModes: [],

  setModes: (modes) => set({ selectedModes: dedupe(modes) }),
  toggleMode: (mode) =>
    set((state) => ({
      selectedModes: state.selectedModes.includes(mode)
        ? state.selectedModes.filter((m) => m !== mode)
        : [...state.selectedModes, mode],
    })),
  reset: () => set({ selectedModes: [] }),

  activeModes: () => {
    const selected = get().selectedModes;
    return selected.length > 0 ? selected : [DEFAULT_PERSONA_MODE];
  },
  isModeActive: (mode) => get().activeModes().includes(mode),
});

function dedupe(modes: SentinelMode[]): SentinelMode[] {
  return [...new Set(modes)];
}

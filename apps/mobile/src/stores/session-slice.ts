/**
 * Session store (R1, R26).
 *
 * Holds the authenticated API session, the local identity flags (a private key
 * exists in the Secure_Enclave), the preferred display name (R1.7), and the
 * recorded Safety_Disclaimer acceptance (R26.2/R26.3). It deliberately never
 * holds private-key bytes — those live only in the Secure_Enclave.
 */
import type { AuthSession } from "@kshema/types";
import type { DisclaimerAcceptance } from "../domain/disclaimer.js";
import { canActivateAmbientShield } from "../domain/disclaimer.js";
import { requiresPreferredNamePrompt } from "../domain/preferred-name.js";
import type { GetState, SetState, SliceCreator } from "./slice.js";

export interface SessionState {
  /** Authenticated API session, or null when signed out. */
  session: AuthSession | null;
  /** True once an RSA identity exists in the Secure_Enclave (never the key). */
  hasIdentity: boolean;
  /** Preferred display name (R1.6/R1.7), or null if not yet provided. */
  preferredName: string | null;
  /** Recorded Safety_Disclaimer acceptance (R26.3), or null. */
  disclaimerAcceptance: DisclaimerAcceptance | null;

  // actions
  setSession: (session: AuthSession | null) => void;
  markIdentityCreated: () => void;
  clearIdentity: () => void;
  setPreferredName: (name: string) => void;
  acceptDisclaimer: (acceptance: DisclaimerAcceptance) => void;
  signOut: () => void;

  // selectors
  isAuthenticated: () => boolean;
  needsPreferredName: () => boolean;
  canActivateShield: () => boolean;
}

export const createSessionSlice: SliceCreator<SessionState> = (
  set: SetState<SessionState>,
  get: GetState<SessionState>,
) => ({
  session: null,
  hasIdentity: false,
  preferredName: null,
  disclaimerAcceptance: null,

  setSession: (session) => set({ session }),
  markIdentityCreated: () => set({ hasIdentity: true }),
  clearIdentity: () => set({ hasIdentity: false }),
  setPreferredName: (name) => set({ preferredName: name }),
  acceptDisclaimer: (acceptance) => set({ disclaimerAcceptance: acceptance }),
  signOut: () =>
    set({
      session: null,
      // identity + disclaimer acceptance persist across sign-out; only the
      // API session is cleared.
    }),

  isAuthenticated: () => get().session !== null,
  needsPreferredName: () => requiresPreferredNamePrompt(get().preferredName),
  canActivateShield: () => canActivateAmbientShield(get().disclaimerAcceptance),
});

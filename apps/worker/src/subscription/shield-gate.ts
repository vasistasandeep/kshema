/**
 * Shield_Paused suspension gate (R20.2, R20.3, R20.5).
 *
 * A Circle's `Subscription.tier` is one of `TRIAL | PRO | SHIELD_PAUSED`
 * (design `enum SubscriptionTier`). When a trial lapses without a paid
 * subscription the Circle transitions into `SHIELD_PAUSED_State`, in which the
 * Sentinel_Worker must suspend, for that Circle:
 *
 *   - scheduled routine (grace) checks,
 *   - automated WhatsApp check-in pings,
 *   - delayed escalation-queue advancement, and
 *   - automated IVR / hyperlocal dispatch.
 *
 * i.e. no routine check runs and no escalation stage fires while the tier is
 * `SHIELD_PAUSED` (R20.5). This mirrors the Sanctuary Mode gate
 * (`sanctuary/gate.ts`): before opening/advancing a routine incident the worker
 * consults this gate and, if the Circle is Shield_Paused, suppresses.
 *
 *   shouldSuspend(circle):
 *     tier = lookupTier(circle)
 *     if isShieldPaused(tier): return SUSPENDED   # no routine eval, pings, stages, IVR (R20.5)
 *     return EVALUATE                             # TRIAL and PRO keep full capabilities (R20.2)
 *
 * ── CRITICAL EMERGENCY BOUNDARY (R20.3, R20.5) ──────────────────────────────
 * This gate ONLY governs the *routine / scheduled* rhythm-and-escalation path.
 * It is deliberately consulted at exactly one place — the routine grace-check
 * incident-open decision (and, by extension, the timed escalation advancement
 * that flows from a routine incident). It is NEVER consulted on an EMERGENCY
 * entry point:
 *
 *   - Shadow_SOS hardware duress handoff (`sos.triggered` → resolution path),
 *   - acoustic-distress classification incidents, and
 *   - hardware-triggered duress incidents
 *
 * remain fully functional even while a Circle is Shield_Paused. Equally, during
 * the TRIAL period a Circle keeps FULL capabilities including emergency
 * escalation, acoustic classification, and hardware duress (R20.3). The
 * suppression here is therefore *structural*: because SOS / acoustic / hardware
 * paths never call this gate, there is simply no code path by which
 * `SHIELD_PAUSED` can suppress an emergency. See
 * {@link SHIELD_EMERGENCY_PATHS_UNAFFECTED}.
 *
 * Everything in this module is **pure** with respect to its seam: the tier
 * lookup is injected, {@link isShieldPaused} is a deterministic predicate over a
 * tier value, and no clock is read, no I/O is performed, and no input is
 * mutated. Re-consulting after a tier change (SHIELD_PAUSED→PRO on Pro purchase,
 * R20.8; SHIELD_PAUSED→TRIAL on admin extension, R20.19) simply re-reads the
 * current tier, so resumption is automatic and idempotent.
 */

import type { SubscriptionTier } from "@kshema/database";

/**
 * Structural guarantee marker (R20.3/R20.5): the Shield_Paused gate never
 * suppresses an EMERGENCY path. It is only ever consulted on the routine
 * grace-check / timed-escalation path — never on Shadow_SOS, acoustic-distress,
 * or hardware-duress entry points. Preservation of emergency capability is
 * therefore structural, not behavioral: there is no code path from an emergency
 * entry point into this gate.
 */
export const SHIELD_EMERGENCY_PATHS_UNAFFECTED = true as const;

/**
 * Pure predicate: is the given Subscription_Tier the Shield_Paused state?
 *
 * `true` iff `tier === "SHIELD_PAUSED"`. `TRIAL` and `PRO` both resolve to
 * `false` — they retain full Pro_Tier capabilities (R20.2). An `undefined` /
 * unknown tier is treated as NOT paused (fail-safe: never suspend protection
 * on a missing/garbled tier — the routine path proceeds and is governed by the
 * other gates).
 */
export function isShieldPaused(tier: SubscriptionTier | undefined | null): boolean {
  return tier === "SHIELD_PAUSED";
}

/**
 * Injectable seam that resolves the current `Subscription.tier` for one Circle.
 * Kept narrow so tests pass a pure closure and production wiring passes a
 * DB-backed lookup (e.g. Prisma `subscription.findUnique({ where: { circleId },
 * select: { tier: true } })`) or a cache primed by the `subscription.changed`
 * event (task 15.1). May resolve `undefined` when no Subscription row exists;
 * {@link isShieldPaused} treats that as NOT paused.
 */
export type LookupSubscriptionTier = (
  circleId: string,
) => Promise<SubscriptionTier | undefined | null> | SubscriptionTier | undefined | null;

/**
 * The guard the routine incident-open / escalation-advance path consults.
 * When the Circle's tier is `SHIELD_PAUSED` it suppresses the routine grace
 * check, WhatsApp ping, delayed escalation advancement, and IVR/dispatch — i.e.
 * no routine incident opens and no stage fires (R20.5). It is NEVER consulted on
 * an emergency path (R20.3/R20.5) — see module docs.
 */
export interface ShieldGate {
  /**
   * Resolve whether the routine path for `circleId` must be suspended.
   * `true` ⇒ the Circle is Shield_Paused ⇒ do NOT open a routine incident and
   * do NOT fire an escalation stage (R20.5). `false` ⇒ proceed with the normal
   * decision (TRIAL / PRO, R20.2). Never throws for a missing Subscription; an
   * absent tier resolves to `false` (evaluate normally).
   */
  shouldSuspend(circleId: string): Promise<boolean>;
}

/**
 * Build a {@link ShieldGate} over an injectable tier-lookup seam.
 *
 * The gate is stateless: every consult re-reads the Circle's current tier and
 * re-evaluates {@link isShieldPaused}, so resumption after SHIELD_PAUSED→PRO
 * (R20.8) or SHIELD_PAUSED→TRIAL (R20.19) is purely a function of the looked-up
 * tier. It performs no writes and touches no other state.
 */
export function createShieldGate(lookupTier: LookupSubscriptionTier): ShieldGate {
  return {
    async shouldSuspend(circleId: string): Promise<boolean> {
      const tier = await lookupTier(circleId);
      return isShieldPaused(tier);
    },
  };
}

/**
 * A no-op gate that never suspends. Useful as a safe default for wiring that
 * has not yet been given a real tier source, and as an explicit
 * "tier-gating disabled" seam in tests. TRIAL and PRO both behave this way.
 */
export function createNoopShieldGate(): ShieldGate {
  return {
    async shouldSuspend(): Promise<boolean> {
      return false;
    },
  };
}

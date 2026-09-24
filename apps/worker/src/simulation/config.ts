/**
 * Simulation_Mode configuration + wiring seams (task 17.1, R25.1–25.4).
 *
 * Simulation_Mode is a developer "time-warp" toggle (R25) that lets the full
 * escalation pipeline be exercised without carrier cost or real emergencies:
 *
 *   - **Time compression (R25.1):** the escalation processor's `stageInterval`
 *     is read from a compressed config (e.g. 10s) instead of the production
 *     20-minute interval.
 *   - **Mock carrier routing (R25.2):** WhatsApp/SMS/IVR dispatch routes to the
 *     {@link MockCarrierAdapter} console logger instead of a live gateway.
 *   - **Non-production + authorized-admin gate (R25.3):** Simulation_Mode is
 *     refused in production and is only honored for an authorized Admin_User.
 *     The *actual* admin authentication is the API's concern; here we model the
 *     authorization as a documented precondition and honor an explicit enable
 *     flag (`adminAuthorized`) that the caller supplies once it has verified the
 *     requesting Admin_User. Absent that flag, Simulation_Mode stays off.
 *   - **Simulated flagging (R25.4):** all resulting Safety_Incidents and
 *     dispatches are flagged `simulated=true` (and labeled in the
 *     Admin_Audit_Ledger by the admin surface).
 *
 * This module is deliberately *pure*: it reads env-shaped input and returns a
 * plain decision object. The escalation processor and dispatch wiring consume
 * {@link SimulationDecision} to pick the stage interval, the carrier adapter,
 * and the `simulated` flag — so tests stay hermetic and production wiring never
 * has to branch on `process.env` directly.
 */

import { z } from "zod";

import { DEFAULT_STAGE_INTERVAL_MS } from "../escalation/processor.js";
import type { CarrierAdapter } from "../carrier/index.js";
import { MockCarrierAdapter } from "../carrier/index.js";

/**
 * Default compressed stage interval used when Simulation_Mode is enabled but no
 * explicit `SIMULATION_STAGE_INTERVAL_MS` is supplied. 10 seconds mirrors the
 * design's "e.g. 10s instead of 20m" example (R25.1).
 */
export const DEFAULT_SIMULATION_STAGE_INTERVAL_MS = 10 * 1000;

/**
 * Upper bound on the compressed interval: it must be strictly *below* the
 * production 20-minute interval, otherwise "compression" is meaningless. A
 * misconfiguration that sets it >= production is rejected so the mode fails
 * fast rather than silently behaving like production.
 */
export const MAX_SIMULATION_STAGE_INTERVAL_MS = DEFAULT_STAGE_INTERVAL_MS - 1;

/**
 * Env-shaped Simulation_Mode inputs. Parsed with Zod so a bad value fails fast
 * with a descriptive error. `NODE_ENV` is included because R25.3 forbids
 * Simulation_Mode in production regardless of the enable flag.
 */
const SimulationEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    /** Master enable flag for Simulation_Mode. */
    SIMULATION_MODE: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((v) => coerceBool(v)),
    /** Compressed stage interval (ms). Defaults to 10s when omitted. */
    SIMULATION_STAGE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_SIMULATION_STAGE_INTERVAL_MS)
      .optional(),
  })
  .transform((raw) => ({ ...raw }));

/** Coerce a boolean-ish env value ("1"/"true"/"yes"/true) to a boolean. */
function coerceBool(v: boolean | string | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

/** Extra (non-env) preconditions supplied by the caller. */
export interface SimulationGateInput {
  /**
   * Whether the requesting actor is an authorized Admin_User (R25.3). The API/
   * admin surface performs the real MFA/RBAC check and passes the result here;
   * this module treats it as a documented precondition. Defaults to `false`, so
   * Simulation_Mode is off unless an authorized admin explicitly enabled it.
   */
  adminAuthorized?: boolean;
}

/** The resolved Simulation_Mode decision consumed by the worker wiring. */
export interface SimulationDecision {
  /** Whether Simulation_Mode is active after applying every gate. */
  enabled: boolean;
  /**
   * Stage interval the escalation processor should use: the compressed value
   * when enabled, else the production {@link DEFAULT_STAGE_INTERVAL_MS} (R25.1).
   */
  stageIntervalMs: number;
  /** Whether resulting incidents/dispatches must be flagged simulated (R25.4). */
  simulated: boolean;
  /**
   * Human-readable reason Simulation_Mode is off, when `enabled` is false.
   * Useful for the Admin_Audit_Ledger and diagnostics. `undefined` when enabled.
   */
  disabledReason?:
    | "flag-off"
    | "production-refused"
    | "admin-unauthorized";
}

/**
 * Resolve the Simulation_Mode decision from env-shaped input + caller gates.
 *
 * The gates apply in this order (a later gate can only *keep* the mode off):
 *   1. `SIMULATION_MODE` must be truthy (else `flag-off`).
 *   2. `NODE_ENV` must not be `production` (else `production-refused`, R25.3).
 *   3. the caller must report an authorized admin (else `admin-unauthorized`).
 *
 * When enabled, `stageIntervalMs` is the compressed value (R25.1) and
 * `simulated` is `true` (R25.4). When disabled, the production interval is
 * returned and `simulated` is `false`, so a caller can use this decision
 * unconditionally.
 *
 * @throws if `SIMULATION_STAGE_INTERVAL_MS` is present but invalid (non-int,
 * non-positive, or not below the production interval).
 */
export function resolveSimulationMode(
  env: NodeJS.ProcessEnv = process.env,
  gate: SimulationGateInput = {},
): SimulationDecision {
  const parsed = SimulationEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid Simulation_Mode configuration: ${issues}`);
  }
  const {
    NODE_ENV,
    SIMULATION_MODE: flag,
    SIMULATION_STAGE_INTERVAL_MS: interval,
  } = parsed.data;

  const off = (
    reason: NonNullable<SimulationDecision["disabledReason"]>,
  ): SimulationDecision => ({
    enabled: false,
    stageIntervalMs: DEFAULT_STAGE_INTERVAL_MS,
    simulated: false,
    disabledReason: reason,
  });

  if (!flag) return off("flag-off");
  // R25.3: never in production, regardless of the enable flag.
  if (NODE_ENV === "production") return off("production-refused");
  // R25.3: only for an authorized Admin_User.
  if (gate.adminAuthorized !== true) return off("admin-unauthorized");

  return {
    enabled: true,
    stageIntervalMs: interval ?? DEFAULT_SIMULATION_STAGE_INTERVAL_MS,
    simulated: true,
  };
}

/**
 * Pick the carrier adapter for a resolved decision (R25.2).
 *
 * When Simulation_Mode is enabled, dispatch routes to a
 * {@link MockCarrierAdapter} console logger; otherwise it uses the supplied live
 * adapter. The mock factory is injectable so tests can pass a pre-recorded
 * instance and assert what was "sent".
 */
export function selectCarrierAdapter(
  decision: SimulationDecision,
  liveAdapter: CarrierAdapter,
  makeMock: () => CarrierAdapter = () => new MockCarrierAdapter(),
): CarrierAdapter {
  return decision.enabled ? makeMock() : liveAdapter;
}

/**
 * STAGE_4 hyperlocal dispatch content assembly (R14, task 13.1).
 *
 * This is the *content* half of Hyperlocal_Dispatch that task 12.2 deliberately
 * left as an input. Given a `HyperlocalContactProfile` (and the incident's
 * Anchor context), it produces — purely, with no I/O — everything the existing
 * dispatch machinery (`runVoiceHandshakeDispatch` / `createDispatchProcessor`)
 * needs to fan out the STAGE_4 priority voice calls + priority SMS:
 *
 *   - a dynamically-generated message that INCLUDES the Anchor building, flat,
 *     society, and door-access details from the profile (R14.2 / R14.4);
 *   - the ORDERED contact list — Primary Observer, then society gate, then the
 *     immediate neighbor — for the simultaneous priority voice calls and the
 *     priority SMS (R14.1 / R14.3);
 *   - a priority SMS body reusing the same dynamic message (R14.3).
 *
 * It also exposes the manual-dispatch authority gate (R14.5): given the Circle
 * members who could *manually* initiate a Hyperlocal_Dispatch, exclude anyone
 * lacking `canTriggerIVR`. The automatic STAGE_4 escalation (R14.1) is driven
 * by the FSM and is not subject to this per-member gate; the gate applies to
 * MANUAL initiation only.
 *
 * Everything here is pure and serializable so it can be assembled by the
 * STAGE_4 producer and handed to the `dispatch` queue as `contacts` +
 * `messageText` + `smsBody` on the {@link DispatchJobData} payload, and the
 * dispatch record is appended to the incident audit trail via the existing
 * `appendAudit` seam pattern (see {@link buildHyperlocalDispatchAudit}).
 */

import type { DispatchContact } from "./dispatch.js";

/**
 * The subset of `HyperlocalContactProfile` this module consumes. Mirrors the
 * Prisma model (all address/phone fields nullable) so callers can pass the row
 * straight through. Kept local (not imported from `@kshema/database`) so this
 * pure module has no DB dependency.
 */
export interface HyperlocalProfileInput {
  building?: string | null;
  flat?: string | null;
  society?: string | null;
  doorAccess?: string | null;
  primaryObserverPhone?: string | null;
  gatePhone?: string | null;
  neighborPhone?: string | null;
}

/** Incident context woven into the dynamic message (R14.4). */
export interface HyperlocalIncidentContext {
  /** The incident this dispatch belongs to (for audit correlation). */
  incidentId: string;
  /** Anchor preferred display name, when known (Brand_Lexicon term "Anchor"). */
  anchorName?: string | null;
}

/** Stable contact ids used for audit correlation + ordering. */
export const HYPERLOCAL_CONTACT_IDS = {
  primaryObserver: "primary-observer",
  gate: "society-gate",
  neighbor: "neighbor",
} as const;

/** Human-facing labels for each hyperlocal contact role. */
export const HYPERLOCAL_CONTACT_LABELS = {
  primaryObserver: "Primary Observer",
  gate: "Society Gate",
  neighbor: "Neighbor",
} as const;

/**
 * The assembled STAGE_4 content: the ordered contact list plus the dynamic
 * message reused for both the voice handshake and the priority SMS.
 */
export interface HyperlocalDispatchContent {
  /**
   * Ordered failover contact list (R14.1 order: Primary Observer, gate,
   * neighbor). Only contacts with a phone present in the profile appear.
   */
  contacts: DispatchContact[];
  /** Dynamic spoken message incl. building/flat/society/door-access (R14.2/14.4). */
  messageText: string;
  /** Priority SMS body (R14.3) — reuses the same dynamic message. */
  smsBody: string;
}

/** A single "detail: value" segment of the dynamic message. */
interface MessageSegment {
  label: string;
  value: string;
}

/**
 * Build the ordered contact list from the profile (R14.1). Order is fixed:
 * Primary Observer → society gate → immediate neighbor. A role is omitted only
 * when its phone number is absent from the profile (nothing to dial).
 */
export function assembleHyperlocalContacts(
  profile: HyperlocalProfileInput,
): DispatchContact[] {
  const ordered: Array<{ id: string; label: string; phone?: string | null }> = [
    {
      id: HYPERLOCAL_CONTACT_IDS.primaryObserver,
      label: HYPERLOCAL_CONTACT_LABELS.primaryObserver,
      phone: profile.primaryObserverPhone,
    },
    {
      id: HYPERLOCAL_CONTACT_IDS.gate,
      label: HYPERLOCAL_CONTACT_LABELS.gate,
      phone: profile.gatePhone,
    },
    {
      id: HYPERLOCAL_CONTACT_IDS.neighbor,
      label: HYPERLOCAL_CONTACT_LABELS.neighbor,
      phone: profile.neighborPhone,
    },
  ];

  const contacts: DispatchContact[] = [];
  for (const c of ordered) {
    const phone = c.phone?.trim();
    if (phone) {
      contacts.push({ id: c.id, phone, label: c.label });
    }
  }
  return contacts;
}

/**
 * Generate the dynamic Hyperlocal_Dispatch message (R14.2 / R14.4).
 *
 * The message is generated from the profile + incident context: it always
 * includes whichever of building / flat / society / door-access are present.
 * Missing fields are simply omitted (a nullable profile field contributes no
 * segment) so the message never contains empty "flat: " placeholders.
 */
export function assembleHyperlocalMessage(
  profile: HyperlocalProfileInput,
  context: HyperlocalIncidentContext,
): string {
  const who = context.anchorName?.trim()
    ? context.anchorName.trim()
    : "the resident";

  const segments: MessageSegment[] = [];
  const push = (label: string, value?: string | null): void => {
    const v = value?.trim();
    if (v) {
      segments.push({ label, value: v });
    }
  };
  push("Society", profile.society);
  push("Building", profile.building);
  push("Flat", profile.flat);
  push("Door access", profile.doorAccess);

  const head =
    `Urgent well-being check for ${who}. ` +
    `Please go to the flat and check on them.`;
  const details =
    segments.length > 0
      ? " " + segments.map((s) => `${s.label}: ${s.value}.`).join(" ")
      : "";

  return `${head}${details}`;
}

/**
 * Assemble the complete STAGE_4 dispatch content (contacts + message + SMS
 * body) for the existing dispatch machinery to send. Pure; the caller enqueues
 * this onto the `dispatch` queue (kind `hyperlocal_dispatch`).
 */
export function assembleHyperlocalDispatch(
  profile: HyperlocalProfileInput,
  context: HyperlocalIncidentContext,
): HyperlocalDispatchContent {
  const messageText = assembleHyperlocalMessage(profile, context);
  return {
    contacts: assembleHyperlocalContacts(profile),
    messageText,
    // The priority SMS reuses the same dynamic content (R14.3), so a responder
    // who cannot take the voice call still gets the address + door access.
    smsBody: messageText,
  };
}

/**
 * A member who could MANUALLY initiate a Hyperlocal_Dispatch. `canTriggerIVR`
 * is the per-CircleMember authority flag from the schema (R2.7).
 */
export interface ManualDispatchMember {
  /** CircleMember id. */
  id: string;
  /** Authority to trigger Hyperlocal_Dispatch (R2.7 / R14.5). */
  canTriggerIVR: boolean;
}

/**
 * Filter the members permitted to MANUALLY initiate Hyperlocal_Dispatch,
 * excluding anyone lacking `canTriggerIVR` (R14.5). The automatic STAGE_4
 * escalation is FSM-driven and not gated per-member; this gate applies only to
 * manual initiation.
 */
export function eligibleManualDispatchers<T extends ManualDispatchMember>(
  members: readonly T[],
): T[] {
  return members.filter((m) => m.canTriggerIVR === true);
}

/**
 * True iff the given member may manually initiate Hyperlocal_Dispatch (R14.5).
 */
export function canManuallyDispatch(member: ManualDispatchMember): boolean {
  return member.canTriggerIVR === true;
}

/**
 * An audit-trail entry recording that a Hyperlocal_Dispatch was initiated
 * (R14.6). This uses the same `appendAudit` seam the voice-handshake attempts
 * use (`dispatch.ts`), but is a distinct discriminated `kind` so audit
 * consumers can separate the "dispatch initiated" record from the per-attempt
 * handshake records.
 */
export interface HyperlocalDispatchAuditEntry {
  /** Discriminator for the incident audit trail. */
  kind: "hyperlocal_dispatch";
  /** The incident the dispatch belongs to. */
  incidentId: string;
  /** Ordered ids of the contacts dialed/messaged (R14.1). */
  contactIds: string[];
  /** How the dispatch was initiated. Automatic STAGE_4 vs manual (R14.5). */
  initiatedBy: "AUTOMATIC_STAGE_4" | "MANUAL";
  /** The CircleMember who manually initiated, when `initiatedBy === "MANUAL"`. */
  initiatedByMemberId?: string;
  /** When the dispatch was initiated (epoch-ms). */
  at: number;
}

/** Inputs to build a {@link HyperlocalDispatchAuditEntry}. */
export interface BuildHyperlocalAuditInput {
  incidentId: string;
  content: HyperlocalDispatchContent;
  at: number;
  initiatedBy?: "AUTOMATIC_STAGE_4" | "MANUAL";
  initiatedByMemberId?: string;
}

/**
 * Build the "dispatch initiated" audit entry (R14.6). Pure; the caller appends
 * it via the existing `appendAudit` seam (Prisma read-modify-write in prod).
 */
export function buildHyperlocalDispatchAudit(
  input: BuildHyperlocalAuditInput,
): HyperlocalDispatchAuditEntry {
  return {
    kind: "hyperlocal_dispatch",
    incidentId: input.incidentId,
    contactIds: input.content.contacts.map((c) => c.id),
    initiatedBy: input.initiatedBy ?? "AUTOMATIC_STAGE_4",
    at: input.at,
    ...(input.initiatedByMemberId !== undefined
      ? { initiatedByMemberId: input.initiatedByMemberId }
      : {}),
  };
}

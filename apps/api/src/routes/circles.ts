/**
 * Circle, invitation, join, and member-permission routes (R2.1-R2.8, R20.1).
 *
 * Mounted under `/api/v1`, so effective paths are:
 *   - `POST  /api/v1/circles`                        create a circle (+ TRIAL + first invite)
 *   - `POST  /api/v1/circles/:id/invitations`        mint an expiring, single-use invite
 *   - `POST  /api/v1/circles/join`                   redeem an invite, join as a member
 *   - `PATCH /api/v1/circles/:id/members/:memberId`  set a member's permission flags (SUPER only)
 *
 * All routes require a valid bearer token (`app.authenticate`).
 *
 * SUPER convention (R2.7) — CircleRole has no dedicated SUPER value
 * (ANCHOR|OBSERVER|MUTUAL). The founding member (the circle creator, task 4.1)
 * is the de-facto "SUPER" member: on `POST /circles` they are created MUTUAL
 * with BOTH `canTriggerIVR` and `canAccessBlackBox` set to true, and no join
 * flow grants both flags (a joiner starts with both false). A caller therefore
 * qualifies as SUPER for a circle iff their membership in that circle holds
 * both `canTriggerIVR` AND `canAccessBlackBox` true. Only a SUPER member may
 * change another member's permission flags via the PATCH route below.
 *
 * Invitation model — signed JWT + single-use nonce (see
 * `services/invitation-store.ts` for the full rationale). An invitation is a
 * short-lived JWT signed with the same `app.jwt` key used for access tokens,
 * carrying `{ purpose: "circle-invite", circleId, nonce, exp }`. The signature
 * and `exp` make it tamper-evident and self-expiring with no stored token; the
 * `nonce` is the only server-side state, flipped ISSUED -> REDEEMED on join so
 * a token cannot be replayed. The raw token is NEVER stored.
 *
 * `POST /circles` makes the creator the first `CircleMember`. Circles have no
 * dedicated "SUPER" enum value (CircleRole is ANCHOR|OBSERVER|MUTUAL); the
 * creator is the founding/super member and joins as MUTUAL — both Anchor and
 * Observer within their own Circle (R2.6) — with full permissions, since the
 * owner is the one who can later manage member permissions (task 4.2). A TRIAL
 * Subscription is initialized for 14 days from creation (R20.1).
 *
 * `POST /circles/join` records `observerPublicKeyPem` when the joiner takes on
 * an Observer-facing role (OBSERVER or MUTUAL) so the platform can later
 * fan-out-wrap black-box keys to this Observer (R2.8). Only the PUBLIC key is
 * accepted; the private key never transits (R1.8, enforced by the `.strict()`
 * `PublicKeyPem` schema in `@kshema/types`).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CircleInvitationSchema,
  CircleMemberSchema,
  CreateCircleResponseSchema,
  CreateCircleSchema,
  CreateInvitationSchema,
  JoinCircleSchema,
  UpdateMemberPermissionsSchema,
} from "@kshema/types";

import type { InvitationNonceStore } from "../services/invitation-store.js";

/** JWT `purpose` claim distinguishing invites from access/refresh tokens. */
const INVITE_PURPOSE = "circle-invite" as const;

/** Decoded invitation-token claims. */
interface InvitationClaims {
  purpose: typeof INVITE_PURPOSE;
  /** Circle the invite grants membership to. */
  circleId: string;
  /** Single-use nonce tracked server-side to prevent replay. */
  nonce: string;
}

/** Dependencies injected into the circle routes (all replaceable in tests). */
export interface CircleRouteDeps {
  /** Single-use invitation nonce store (Redis in prod, in-memory in tests). */
  invitationStore: InvitationNonceStore;
  /** Invitation lifetime in milliseconds (default 7 days). */
  invitationTtlMs?: number;
  /** Trial length in milliseconds (default 14 calendar days — R20.1). */
  trialDurationMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/** Descriptive error envelope for the 400 rejection path (R2.4). */
const CircleErrorSchema = z
  .object({
    error: z.literal("Bad Request"),
    message: z.string().min(1),
  })
  .strict();

/** Descriptive error envelope for the 403 (non-SUPER caller) path (R2.7). */
const ForbiddenErrorSchema = z
  .object({
    error: z.literal("Forbidden"),
    message: z.string().min(1),
  })
  .strict();

/** Descriptive error envelope for the 404 (unknown circle/member) path (R2.7). */
const NotFoundErrorSchema = z
  .object({
    error: z.literal("Not Found"),
    message: z.string().min(1),
  })
  .strict();

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (R20.1)

export async function circleRoutes(
  app: FastifyInstance,
  deps: CircleRouteDeps,
): Promise<void> {
  const {
    invitationStore,
    invitationTtlMs = DEFAULT_INVITATION_TTL_MS,
    trialDurationMs = DEFAULT_TRIAL_DURATION_MS,
    now = Date.now,
  } = deps;

  const typed = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Mint an expiring, single-use invitation for a circle: sign a JWT carrying
   * a fresh nonce and record that nonce as ISSUED with a matching TTL. Returns
   * the raw token plus its absolute expiry (ISO-8601).
   */
  async function mintInvitation(circleId: string): Promise<{
    inviteToken: string;
    expiresAt: string;
  }> {
    const nonce = randomUUID();
    const expiresAtMs = now() + invitationTtlMs;

    // `expiresIn` (seconds) drives the JWT `exp`, so signature verification
    // rejects an expired invite even before we consult the nonce store.
    //
    // `@fastify/jwt` types `sign`/`verify` to the access-token payload; an
    // invitation carries a distinct claim set, so we sign it through a cast.
    // The `purpose` claim keeps invite and access tokens from being confused.
    const invitationClaims: InvitationClaims = {
      purpose: INVITE_PURPOSE,
      circleId,
      nonce,
    };
    const signInvite = app.jwt.sign as unknown as (
      payload: InvitationClaims,
      options: { expiresIn: number },
    ) => string;
    const inviteToken = signInvite(invitationClaims, {
      expiresIn: Math.max(1, Math.ceil(invitationTtlMs / 1000)),
    });

    await invitationStore.issue(nonce, invitationTtlMs);

    return { inviteToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  // POST /circles — create a Circle, add the creator as the founding member,
  // initialize a 14-day TRIAL subscription, and return the first invitation
  // (R2.1, R2.2, R20.1).
  typed.post(
    "/circles",
    {
      onRequest: [app.authenticate],
      schema: {
        body: CreateCircleSchema,
        response: { 200: CreateCircleResponseSchema },
      },
    },
    async (request) => {
      const userId = request.user.sub;
      const { name } = request.body;

      const trialEndsAt = new Date(now() + trialDurationMs);

      // One transaction: Circle + founding CircleMember + TRIAL Subscription.
      // The creator is the founding (super) member: MUTUAL role (both Anchor
      // and Observer — R2.6) with full permissions.
      const circle = await app.prisma.circle.create({
        data: {
          name,
          members: {
            create: {
              userId,
              role: "MUTUAL",
              canTriggerIVR: true,
              canAccessBlackBox: true,
            },
          },
          subscription: {
            create: {
              tier: "TRIAL",
              trialEndsAt,
            },
          },
        },
      });

      const invitation = await mintInvitation(circle.id);

      return {
        circleId: circle.id,
        name: circle.name,
        invitation,
      };
    },
  );

  // POST /circles/:id/invitations — mint an additional expiring, single-use
  // invite token for an existing circle (R2.2). The optional `role` in the
  // body is a hint for the client UI; the actual role is chosen by the joiner
  // at redemption time and validated on `POST /circles/join`.
  typed.post(
    "/circles/:id/invitations",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().min(1) }).strict(),
        body: CreateInvitationSchema,
        response: { 200: CircleInvitationSchema, 400: CircleErrorSchema },
      },
    },
    async (request, reply) => {
      const { id: circleId } = request.params;

      // Only mint invites for a circle the caller actually belongs to; this
      // also yields a descriptive 400 for an unknown circle id (R2.4).
      const membership = await app.prisma.circleMember.findFirst({
        where: { circleId, userId: request.user.sub },
      });
      if (!membership) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Circle not found or you are not a member of it.",
        });
      }

      return mintInvitation(circleId);
    },
  );

  // POST /circles/join — validate the invite (signature + expiry + not yet
  // redeemed), add the caller as a CircleMember with the requested role, record
  // the Observer public key for black-box key wrapping when relevant (R2.3,
  // R2.5, R2.8), and mark the invite redeemed. Invalid / expired /
  // already-redeemed tokens -> descriptive 400 (R2.4).
  typed.post(
    "/circles/join",
    {
      onRequest: [app.authenticate],
      schema: {
        body: JoinCircleSchema,
        response: { 200: CircleMemberSchema, 400: CircleErrorSchema },
      },
    },
    async (request, reply) => {
      const userId = request.user.sub;
      const { inviteToken, role, observerPublicKeyPem } = request.body;

      const badRequest = (message: string) =>
        reply.code(400).send({ error: "Bad Request", message });

      // 1) Signature + expiry. A tampered or expired JWT throws here and is a
      // descriptive 400 rather than leaking which check failed (R2.4).
      let claims: InvitationClaims;
      try {
        const decoded = app.jwt.verify(inviteToken) as unknown as InvitationClaims;
        if (decoded.purpose !== INVITE_PURPOSE || !decoded.circleId || !decoded.nonce) {
          return badRequest("The invitation is invalid.");
        }
        claims = decoded;
      } catch {
        return badRequest("The invitation is invalid or has expired.");
      }

      // 2) Single-use: atomically flip the nonce ISSUED -> REDEEMED. A false
      // result means unknown / expired / already-redeemed (R2.4). Redeeming
      // BEFORE the write also prevents a replay racing two joins onto one box.
      const redeemed = await invitationStore.redeem(claims.nonce);
      if (!redeemed) {
        return badRequest("The invitation is invalid, expired, or already used.");
      }

      // Record the Observer public key only for Observer-facing roles (R2.8).
      // A pure Anchor has no black-box key to wrap, so it is not required.
      const isObserverFacing = role === "OBSERVER" || role === "MUTUAL";

      try {
        const member = await app.prisma.circleMember.create({
          data: {
            circleId: claims.circleId,
            userId,
            role,
            ...(isObserverFacing && observerPublicKeyPem
              ? { observerPublicKeyPem }
              : {}),
          },
        });

        return {
          memberId: member.id,
          userId: member.userId,
          role: member.role,
          canTriggerIVR: member.canTriggerIVR,
          canAccessBlackBox: member.canAccessBlackBox,
        };
      } catch {
        // Membership creation failed (e.g. already a member of this circle —
        // the `@@unique([circleId, userId])` constraint). Surface a
        // descriptive 400 (R2.4).
        return badRequest(
          "Unable to join the circle; you may already be a member.",
        );
      }
    },
  );

  // PATCH /circles/:id/members/:memberId — set a member's permission flags
  // `canTriggerIVR` / `canAccessBlackBox` (R2.7). SUPER member only: the caller
  // must belong to the circle with BOTH flags true (the founding-member
  // convention from task 4.1 — see the module docstring). Non-SUPER -> 403;
  // unknown circle/member -> descriptive 404.
  typed.patch(
    "/circles/:id/members/:memberId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z
          .object({ id: z.string().min(1), memberId: z.string().min(1) })
          .strict(),
        body: UpdateMemberPermissionsSchema,
        response: {
          200: CircleMemberSchema,
          403: ForbiddenErrorSchema,
          404: NotFoundErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: circleId, memberId } = request.params;
      const { canTriggerIVR, canAccessBlackBox } = request.body;

      // Authorization: the caller must be a SUPER member of THIS circle —
      // i.e. their own membership holds both permission flags (R2.7). We look
      // up the caller's membership first so a non-member (or a member of a
      // different circle) is treated identically to a non-SUPER member.
      const caller = await app.prisma.circleMember.findFirst({
        where: { circleId, userId: request.user.sub },
      });
      if (!caller) {
        // Caller is not a member of this circle (or the circle is unknown).
        // Do not distinguish the two, to avoid leaking circle existence.
        return reply.code(403).send({
          error: "Forbidden",
          message: "Only a super member of this circle may manage permissions.",
        });
      }
      const isSuper = caller.canTriggerIVR && caller.canAccessBlackBox;
      if (!isSuper) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "Only a super member of this circle may manage permissions.",
        });
      }

      // Target must be a member of the SAME circle (R2.7). Unknown member id
      // (or a member of another circle) -> descriptive 404.
      const target = await app.prisma.circleMember.findFirst({
        where: { id: memberId, circleId },
      });
      if (!target) {
        return reply.code(404).send({
          error: "Not Found",
          message: "No such member in this circle.",
        });
      }

      // Apply only the flags present in the (validated, non-empty) body.
      const updated = await app.prisma.circleMember.update({
        where: { id: target.id },
        data: {
          ...(canTriggerIVR !== undefined ? { canTriggerIVR } : {}),
          ...(canAccessBlackBox !== undefined ? { canAccessBlackBox } : {}),
        },
      });

      return {
        memberId: updated.id,
        userId: updated.userId,
        role: updated.role,
        canTriggerIVR: updated.canTriggerIVR,
        canAccessBlackBox: updated.canAccessBlackBox,
      };
    },
  );
}

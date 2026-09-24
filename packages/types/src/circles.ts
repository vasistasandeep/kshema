/**
 * @kshema/types — circle, role, and permission DTOs (R2).
 *
 * `join` records only the Observer PUBLIC key (`observerPublicKeyPem`) for
 * black-box key wrapping — never a private key (R2.8, R1.8).
 */
import { z } from "zod";
import { CircleRoleSchema } from "./enums.js";
import { Id, IsoDateTime, NonEmptyString, PublicKeyPem } from "./common.js";

export const CreateCircleSchema = z
  .object({
    name: NonEmptyString,
  })
  .strict();
export type CreateCircle = z.infer<typeof CreateCircleSchema>;

export const CircleInvitationSchema = z
  .object({
    inviteToken: NonEmptyString,
    expiresAt: IsoDateTime,
  })
  .strict();
export type CircleInvitation = z.infer<typeof CircleInvitationSchema>;

export const CreateCircleResponseSchema = z
  .object({
    circleId: Id,
    name: NonEmptyString,
    invitation: CircleInvitationSchema,
  })
  .strict();
export type CreateCircleResponse = z.infer<typeof CreateCircleResponseSchema>;

export const CreateInvitationSchema = z
  .object({
    role: CircleRoleSchema.optional(),
  })
  .strict();
export type CreateInvitation = z.infer<typeof CreateInvitationSchema>;

/** Join a circle. Observer public key only — no private key (R2.8, R1.8). */
export const JoinCircleSchema = z
  .object({
    inviteToken: NonEmptyString,
    role: CircleRoleSchema,
    observerPublicKeyPem: PublicKeyPem.optional(),
  })
  .strict();
export type JoinCircle = z.infer<typeof JoinCircleSchema>;

export const UpdateMemberPermissionsSchema = z
  .object({
    canTriggerIVR: z.boolean().optional(),
    canAccessBlackBox: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.canTriggerIVR !== undefined || v.canAccessBlackBox !== undefined, {
    message: "at least one permission field must be provided",
  });
export type UpdateMemberPermissions = z.infer<typeof UpdateMemberPermissionsSchema>;

export const CircleMemberSchema = z
  .object({
    memberId: Id,
    userId: Id,
    role: CircleRoleSchema,
    canTriggerIVR: z.boolean(),
    canAccessBlackBox: z.boolean(),
    preferredName: NonEmptyString.optional(),
  })
  .strict();
export type CircleMember = z.infer<typeof CircleMemberSchema>;

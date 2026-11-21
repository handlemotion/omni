import { z } from "zod";

const isoDate = z.iso.datetime();

/** A pending invitation as the person invited sees it (`GET /api/invitations`). */
export const pendingInvitationSchema = z.object({
  id: z.string().min(1),
  /** The address it was sent to: one of the signed-in person's verified sign-in emails. */
  email: z.string(),
  role: z.string(),
  expiresAt: isoDate,
  organization: z.object({ id: z.string().min(1), name: z.string() }),
  inviter: z.object({ name: z.string(), email: z.string(), image: z.string().nullable() }),
});

/**
 * Every pending, unexpired invitation to a company addressed to any of the signed-in person's
 * verified sign-in emails, oldest first. Join with Better Auth's
 * `POST /api/auth/organization/accept-invitation`, decline with `…/reject-invitation`.
 */
export const pendingInvitationsSchema = z.object({
  invitations: z.array(pendingInvitationSchema),
});

/**
 * One invitation, by the id in its `/invite/<id>` link (`GET /api/invitations/:id`).
 * `wrong_account`: it is addressed to an email this person does not verifiably sign in with, and
 * nothing else about it is answered. `accepted` also when they already belong to its workspace.
 */
export const invitationStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("wrong_account") }),
  z.object({
    status: z.enum(["pending", "expired", "accepted", "declined"]),
    invitation: pendingInvitationSchema,
  }),
]);

export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;
export type PendingInvitations = z.infer<typeof pendingInvitationsSchema>;
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

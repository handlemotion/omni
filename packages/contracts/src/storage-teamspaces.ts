import { z } from "zod";

const id = z.string().min(1);
const isoDate = z.iso.datetime();
const name = z.string().trim().min(1).max(255);

/** A member's role in a teamspace: an `owner` manages it. */
export const storageTeamspaceRoleSchema = z.enum(["member", "owner"]);

/** A teamspace as the caller sees it (`docs/spec/teamspaces.md`). */
export const storageTeamspaceSchema = z.object({
  id,
  orgId: id,
  name: z.string(),
  /** Reached only by its members; open, every member of the workspace reaches it. */
  private: z.boolean(),
  /** The caller's role in it; null in an open teamspace they reach without being in it. */
  role: storageTeamspaceRoleSchema.nullable(),
  /** The caller may rename it, make it open or private, change its members and delete it. */
  manage: z.boolean(),
  createdAt: isoDate,
});

/** `GET /api/storage/teamspaces`: every teamspace the member reaches, by name. */
export const storageTeamspacesResponseSchema = z.object({
  teamspaces: z.array(storageTeamspaceSchema),
});

/**
 * `POST /api/storage/teamspaces`: a teamspace owned by the caller, with `memberIds` (members of
 * the workspace) in it. Answers `{ teamspace }`.
 */
export const storageCreateTeamspaceBodySchema = z.object({
  name,
  private: z.boolean().optional(),
  memberIds: z.array(id).max(500).optional(),
});

/** `PATCH /api/storage/teamspaces/:id`, for whoever manages it. Answers `{ teamspace }`. */
export const storageUpdateTeamspaceBodySchema = z
  .object({ name: name.optional(), private: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.private !== undefined, {
    message: "give name or private",
  });

export const storageTeamspaceResponseSchema = z.object({ teamspace: storageTeamspaceSchema });

export const storageTeamspaceMemberSchema = z.object({
  memberId: id,
  role: storageTeamspaceRoleSchema,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});

/**
 * `GET /api/storage/teamspaces/:id/members`, and the answer to a change of them. A change
 * answers `409 last_owner` when it would leave the teamspace without an owner, and `422
 * not_in_workspace` for someone who is not a member of its workspace.
 */
export const storageTeamspaceMembersResponseSchema = z.object({
  members: z.array(storageTeamspaceMemberSchema),
});

/** `PUT /api/storage/teamspaces/:id/members/:memberId`: adds them, or changes their role. */
export const storagePutTeamspaceMemberBodySchema = z.object({ role: storageTeamspaceRoleSchema });

export type StorageTeamspaceRole = z.infer<typeof storageTeamspaceRoleSchema>;
export type StorageTeamspace = z.infer<typeof storageTeamspaceSchema>;
export type StorageTeamspacesResponse = z.infer<typeof storageTeamspacesResponseSchema>;
export type StorageTeamspaceResponse = z.infer<typeof storageTeamspaceResponseSchema>;
export type StorageTeamspaceMembersResponse = z.infer<typeof storageTeamspaceMembersResponseSchema>;
export type StorageTeamspaceMember = z.infer<typeof storageTeamspaceMemberSchema>;

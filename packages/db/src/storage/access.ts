// The three doors of Storage (ADR 0034 decision 3). A door is handed a node's chain (the node
// and its ancestors) and answers what its holder may do with the node, or null when it opens
// nothing. Every storage operation asks a door; nothing else decides access.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { personalSpaces } from "../schema/identity.ts";
import { storageGrants } from "../schema/storage.ts";
import { companyForAddress } from "../session-scopes.ts";
import { listSignInEmails } from "../sign-in-emails.ts";
import { inTrash, type Drive, type NodeRow, type StorageSpace } from "./core.ts";

/** `member` is someone in the node's space; the other two come from a grant or a link. */
export type StorageRole = "member" | "editor" | "viewer";

export interface Access {
  role: StorageRole;
  /** Index in the chain of the highest folder this door shows; a path stops there. */
  top: number;
  /** May create folders and upload in it, when it is a folder. */
  inside: boolean;
  /** May rename and move it. */
  change: boolean;
  /** May move it to Trash and, for a member, restore it or delete it for good. */
  remove: boolean;
  /** May see and change who it is shared with. */
  share: boolean;
}

export interface Door {
  kind: "member" | "grant" | "link";
  /**
   * What the holder may do with `chain[0]`. A grant or a link opens nothing in Trash; a member
   * still reaches it there, so callers that need a live node check `inTrash` themselves.
   */
  access(ex: Db, chain: NodeRow[]): Promise<Access | null>;
  /** The root of `space` for the holder: their My files, or their company's Shared. */
  root(ex: Db, space: StorageSpace): Promise<Drive | null>;
  /** The member recorded as having made a node or opened an upload in `orgId`. */
  actor(ex: Db, orgId: string): Promise<string | null>;
  /** Whether an upload opened by `memberId` is the holder's. */
  ownsUpload(ex: Db, memberId: string): Promise<boolean>;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

export interface StorageMember {
  id: string;
  orgId: string;
  /** Owner or admin of the workspace. */
  admin: boolean;
  /** The workspace is a Personal space: it has My files and no Shared. */
  personal: boolean;
}

export async function loadMember(ex: Db, memberId: string): Promise<StorageMember | null> {
  const [row] = await ex
    .select({
      id: members.id,
      orgId: members.organizationId,
      role: members.role,
      personal: sql<boolean>`exists (select 1 from ${personalSpaces} where ${personalSpaces.orgId} = ${members.organizationId})`,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row) return null;
  // Better Auth stores several roles as a comma-separated list.
  const admin = row.role.split(",").some((role) => ADMIN_ROLES.has(role.trim()));
  return { id: row.id, orgId: row.orgId, admin, personal: row.personal };
}

/**
 * A member reaches their own My files and, in a company, Shared. Nobody reaches another
 * member's My files, whatever their role. In Shared everyone writes, and only the uploader,
 * owners and admins move a node out of it (to Trash or to My files).
 */
export function memberDoor(memberId: string): Door {
  return {
    kind: "member",
    async access(ex, chain) {
      const node = chain[0];
      const member = await loadMember(ex, memberId);
      if (!node || !member || node.orgId !== member.orgId) return null;
      const mine = node.space === "personal" && node.ownerMemberId === member.id;
      const shared = node.space === "shared" && !member.personal;
      if (!mine && !shared) return null;
      return {
        role: "member",
        top: chain.length - 1,
        inside: node.kind === "folder",
        change: true,
        remove: mine || member.admin || node.createdByMemberId === member.id,
        share: true,
      };
    },
    async root(ex, space) {
      const member = await loadMember(ex, memberId);
      if (!member) return null;
      if (space === "personal") {
        return { orgId: member.orgId, space, ownerMemberId: member.id };
      }
      return member.personal ? null : { orgId: member.orgId, space, ownerMemberId: null };
    },
    async actor(ex, orgId) {
      const member = await loadMember(ex, memberId);
      return member?.orgId === orgId ? member.id : null;
    },
    ownsUpload: async (_ex, uploader) => uploader === memberId,
  };
}

/**
 * The addresses a grant may be addressed to for this session: every address the person has
 * verified (ADR 0014) or, for a session scoped to a company (ADR 0024 decision 3), only those on
 * that company's claimed domains.
 */
export async function grantAddresses(ex: Db, userId: string, scopeOrgId?: string | null) {
  const verified = (await listSignInEmails(ex, userId))
    .filter((address) => address.verified)
    .map((address) => address.email.toLowerCase());
  if (!scopeOrgId) return verified;
  const inScope: string[] = [];
  for (const address of verified) {
    if ((await companyForAddress(ex, address)) === scopeOrgId) inScope.push(address);
  }
  return inScope;
}

/**
 * A grant on the node or on a folder above it, for one of the person's addresses. The strongest
 * role on the way up counts. An editor changes what is inside the folder they were given, not
 * the folder itself; nobody shares, restores or deletes for good through a grant.
 */
export function grantDoor(userId: string, scopeOrgId?: string | null): Door {
  return {
    kind: "grant",
    async access(ex, chain) {
      const node = chain[0];
      if (!node || inTrash(chain)) return null;
      const addresses = await grantAddresses(ex, userId, scopeOrgId);
      if (addresses.length === 0) return null;
      const grants = await ex
        .select({ nodeId: storageGrants.nodeId, role: storageGrants.role })
        .from(storageGrants)
        .where(
          and(
            inArray(
              storageGrants.nodeId,
              chain.map((row) => row.id),
            ),
            inArray(storageGrants.email, addresses),
          ),
        );
      if (grants.length === 0) return null;
      const granted = new Set(grants.map((grant) => grant.nodeId));
      const editing = new Set(
        grants.filter((grant) => grant.role === "editor").map((grant) => grant.nodeId),
      );
      const editorAbove = chain.slice(1).some((row) => editing.has(row.id));
      const editor = editorAbove || editing.has(node.id);
      return {
        role: editor ? "editor" : "viewer",
        top: chain.findLastIndex((row) => granted.has(row.id)),
        inside: editor && node.kind === "folder",
        change: editorAbove,
        remove: editorAbove,
        share: false,
      };
    },
    root: async () => null,
    async actor(ex, orgId) {
      // Their member in the node's workspace when they have one, else their oldest membership.
      const [row] = await ex
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.userId, userId),
            scopeOrgId ? eq(members.organizationId, scopeOrgId) : undefined,
          ),
        )
        .orderBy(sql`(${members.organizationId} = ${orgId}) desc`, members.createdAt, members.id)
        .limit(1);
      return row?.id ?? null;
    },
    async ownsUpload(ex, uploader) {
      const [row] = await ex
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.id, uploader), eq(members.userId, userId)));
      return row !== undefined;
    },
  };
}

/**
 * Anyone holding the link: the node or a folder above it has this `share_id` and is open to
 * anyone. Read only, always: an anonymous editor would be an open upload endpoint.
 */
export function linkDoor(shareId: string): Door {
  return {
    kind: "link",
    async access(_ex, chain) {
      if (chain.length === 0 || inTrash(chain)) return null;
      const top = chain.findIndex((row) => row.shareId === shareId && row.linkAccess === "anyone");
      if (top < 0) return null;
      return { role: "viewer", top, inside: false, change: false, remove: false, share: false };
    },
    root: async () => null,
    actor: async () => null,
    ownsUpload: async () => false,
  };
}

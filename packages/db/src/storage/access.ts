import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { personalSpaces } from "../schema/identity.ts";
import { storageGrants, storagePolicies } from "../schema/storage.ts";
import { companyForAddress } from "../session-scopes.ts";
import { listSignInEmails } from "../sign-in-emails.ts";
import { holdsOthersWork, inTrash, type Drive, type NodeRow, type StorageSpace } from "./core.ts";

/** `member` is someone in the node's space; the others come from a grant or a link. */
export type StorageRole = "member" | "editor" | "commenter" | "viewer";

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

/**
 * Whether the holder may replace a file's content and see what it replaced:
 * a member who reaches it, or an editor, whether the grant is on the file itself or
 * on a folder above it. Unlike `change`, which an editor has only inside the folder they were
 * given: writing a document they were handed is what editing it means.
 */
export const editsContent = (access: Access) =>
  access.role === "member" || access.role === "editor";

/**
 * Whether the holder may read a file's comments and write their own: a
 * member, an editor or a commenter. A viewer, and a link alone, see the file and not what people
 * said about it.
 */
export const readsComments = (access: Access) => access.role !== "viewer";

export interface Door {
  kind: "member" | "grant" | "link";
  /**
   * What the holder may do with `chain[0]`. A grant or a link opens nothing in Trash; a member
   * still reaches it there, so callers that need a live node check `inTrash` themselves.
   */
  access(ex: Db, chain: NodeRow[]): Promise<Access | null>;
  /**
   * Whether the holder may take `node` away with everything inside it: trash it, delete it for
   * good, or move it out of its drive. Asked after `access` allowed `remove` on the node itself.
   */
  removesWhole(ex: Db, node: NodeRow): Promise<boolean>;
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

export const loadMember: (ex: Db, memberId: string) => Promise<StorageMember | null> = async (
  ex,
  memberId,
) => {
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
  const admin = row.role.split(",").some((role) => ADMIN_ROLES.has(role.trim()));
  return { id: row.id, orgId: row.orgId, admin, personal: row.personal };
};

/**
 * A member reaches their own My files and, in a company, Shared. Nobody reaches another
 * member's My files, whatever their role. In Shared everyone writes, and only the uploader,
 * owners and admins move a node out of it (to Trash or to My files); a folder's uploader only
 * while everything inside it is theirs too, or moving a colleague's file into a folder of one's
 * own would be a way to take it.
 */
export const memberDoor: (memberId: string) => Door = (memberId) => {
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
    async removesWhole(ex, node) {
      if (node.space !== "shared" || node.kind !== "folder") return true;
      const member = await loadMember(ex, memberId);
      if (!member) return false;
      return member.admin || !(await holdsOthersWork(ex, node.id, member.id));
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
};

/**
 * The addresses a grant may be addressed to for this session: every address the person has
 * verified or, for a session scoped to a company, only those on
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
 * the folder itself; nobody shares, restores or deletes for good through a grant. In Shared, a
 * grantee who is a member of the workspace takes away no more than their membership lets them:
 * any member can share, so an editor grant to oneself would otherwise undo the member door's rule.
 * With `underShareId` the door opens only the node carrying that link and what is inside it,
 * which is how a request made at `/s/<shareId>` stays in the one workspace it names.
 */
export const grantDoor: (
  userId: string,
  scopeOrgId?: string | null,
  underShareId?: string,
) => Door = (userId, scopeOrgId, underShareId) => {
  async function asMember(ex: Db, node: NodeRow) {
    if (node.space !== "shared") return null;
    const [row] = await ex
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, userId), eq(members.organizationId, node.orgId)));
    return row ? memberDoor(row.id) : null;
  }
  return {
    kind: "grant",
    async access(ex, chain) {
      const node = chain[0];
      if (!node || inTrash(chain)) return null;
      if (underShareId && !chain.some((row) => row.shareId === underShareId)) return null;
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
      const commenter = grants.some((grant) => grant.role === "commenter");
      const member = editorAbove ? await asMember(ex, node) : null;
      const memberRemoves = member ? ((await member.access(ex, chain))?.remove ?? false) : true;
      return {
        role: editor ? "editor" : commenter ? "commenter" : "viewer",
        top: chain.findLastIndex((row) => granted.has(row.id)),
        inside: editor && node.kind === "folder",
        change: editorAbove,
        remove: editorAbove && memberRemoves,
        share: false,
      };
    },
    async removesWhole(ex, node) {
      return (await (await asMember(ex, node))?.removesWhole(ex, node)) ?? true;
    },
    root: async () => null,
    async actor(ex, orgId) {
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
};

/** A workspace's sharing policy; a workspace that never set one allows everything. */
export interface StoragePolicy {
  /** Links open to anyone may be made and opened. */
  publicLinks: boolean;
  /** People outside the company may be invited by address. */
  outsideSharing: boolean;
}

export async function storagePolicyOf(ex: Db, orgId: string) {
  const [row] = await ex
    .select({
      publicLinks: storagePolicies.publicLinks,
      outsideSharing: storagePolicies.outsideSharing,
    })
    .from(storagePolicies)
    .where(eq(storagePolicies.orgId, orgId));
  return (row ?? { publicLinks: true, outsideSharing: true }) satisfies StoragePolicy;
}

/** Who is opening a link: what the link door needs beyond the link itself. */
export interface LinkVisitor {
  /** The signed-in user, for a link open to the workspace's members. */
  userId?: string | null;
  /** The session's scope: with one, only that workspace's links open to members. */
  scopeOrgId?: string | null;
  /** Whether the visitor unlocked this password-protected link (see `@omni/crypto` link keys). */
  unlocked?: (link: { shareId: string; passwordHash: string }) => Promise<boolean>;
  now?: Date;
}

/**
 * What a link does for `visitor`: `open`, `locked` until they give its password, or `closed`.
 * `node` is the node carrying the link. A link opens nothing once it expires, while the
 * workspace's policy forbids links open to anyone, or, when it is open to the workspace's
 * members, for anyone else.
 */
export async function linkState(ex: Db, node: NodeRow, visitor: LinkVisitor = {}) {
  const now = visitor.now ?? new Date();
  if (!node.shareId || node.linkAccess === "restricted") return "closed";
  if (node.linkExpiresAt && node.linkExpiresAt <= now) return "closed";
  if (node.linkAccess === "anyone" && !(await storagePolicyOf(ex, node.orgId)).publicLinks) {
    return "closed";
  }
  if (node.linkAccess === "workspace") {
    if (!visitor.userId || (visitor.scopeOrgId && visitor.scopeOrgId !== node.orgId)) {
      return "closed";
    }
    const [member] = await ex
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, visitor.userId), eq(members.organizationId, node.orgId)));
    if (!member) return "closed";
  }
  if (node.linkPasswordHash) {
    const link = { shareId: node.shareId, passwordHash: node.linkPasswordHash };
    if (!(await visitor.unlocked?.(link))) return "locked";
  }
  return "open";
}

export type LinkState = Awaited<ReturnType<typeof linkState>>;

/**
 * Anyone holding the link, while `linkState` says it is open for them: the node or a folder
 * above it has this `share_id`. Read only, always: an anonymous editor would be an open upload
 * endpoint.
 */
export const linkDoor: (shareId: string, visitor?: LinkVisitor) => Door = (
  shareId,
  visitor = {},
) => {
  return {
    kind: "link",
    async access(ex, chain) {
      if (chain.length === 0 || inTrash(chain)) return null;
      const top = chain.findIndex((row) => row.shareId === shareId);
      if (top < 0 || (await linkState(ex, chain[top]!, visitor)) !== "open") return null;
      return { role: "viewer", top, inside: false, change: false, remove: false, share: false };
    },
    removesWhole: async () => false,
    root: async () => null,
    actor: async () => null,
    ownsUpload: async () => false,
  };
};

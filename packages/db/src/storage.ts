// Storage (ADR 0034): the one place access to files and folders is decided. A node is reached
// through exactly one of three doors, and routes never query the storage tables themselves:
//
// 1. Member: `forMember(db, memberId).storage`. Their own My files and, in a company, Shared.
// 2. Grant: `forUser(db, userId, scopeOrgId).storage`. Nodes granted to an address they verified.
// 3. Link: `publicStorage(db, shareId)`. Nodes under a link open to anyone. No session.
//
// The parts live in `./storage/`: `access.ts` is the doors, the rest is what goes through them.
import type { Db } from "./client.ts";
import { grantAddresses, grantDoor, linkDoor, loadMember, memberDoor } from "./storage/access.ts";
import type { StorageListCursor } from "./storage/core.ts";
import { storageUsageOf } from "./storage/maintenance.ts";
import { listSharedWith, sharingOperations, type SharedWithMeCursor } from "./storage/sharing.ts";
import { trashOperations } from "./storage/trash.ts";
import { treeOperations } from "./storage/tree.ts";
import { uploadOperations } from "./storage/uploads.ts";

export {
  STORAGE_MAX_DEPTH,
  STORAGE_NAME_MAX_LENGTH,
  storageObjectKey,
  type StorageListCursor,
  type StorageNode,
  type StorageNodeKind,
  type StorageSpace,
} from "./storage/core.ts";
export type { StorageRole } from "./storage/access.ts";
export type {
  CreateFolderResult,
  FileResult,
  ListResult,
  MoveResult,
  NodeResult,
  RenameResult,
  StorageNodeView,
  StoragePathEntry,
  StoragePlace,
} from "./storage/tree.ts";
export {
  STORAGE_TRASH_DAYS,
  type DeleteForeverResult,
  type RestoreResult,
  type StorageTrashCursor,
} from "./storage/trash.ts";
export {
  expiredStorageUploads,
  removeStorageUpload,
  STORAGE_UPLOAD_TTL_MS,
  type AbortUploadResult,
  type CompleteUploadResult,
  type OpenUploadResult,
  type RecordPartResult,
  type StorageFull,
  type StorageUpload,
} from "./storage/uploads.ts";
export type {
  PutGrantResult,
  RemoveGrantResult,
  SharedWithMeCursor,
  SharedWithMeItem,
  SharingResult,
  StorageGrantRole,
  StorageLinkAccess,
  StoragePerson,
  StorageSharing,
} from "./storage/sharing.ts";
export { handOverMemberStorage, type StorageHandOverResult } from "./storage/handover.ts";
export {
  deletedStorageWorkspaces,
  deleteWorkspaceStorage,
  purgeStorageTrash,
  randomStorageSweepStart,
  recomputeStorageUsage,
  storageUsageOf,
} from "./storage/maintenance.ts";
export type { StorageUploadPart } from "./schema/storage.ts";

/**
 * The member door. Everything a member does in their workspace's Storage: browse and change
 * their own My files and (in a company) Shared, upload, trash and restore, and share. No
 * function here reaches another member's My files, whatever the caller's role.
 */
export function memberStorage(db: Db, memberId: string) {
  const door = memberDoor(memberId);
  return {
    ...treeOperations(db, door),
    ...uploadOperations(db, door),
    ...trashOperations(db, door, memberId),
    ...sharingOperations(db, door),
    /** The workspace's bytes stored and reserved, or null when the member is gone. */
    async usage() {
      const member = await loadMember(db, memberId);
      return member ? storageUsageOf(db, member.orgId) : null;
    },
  };
}

/**
 * The grant door. What was shared with the person by address, in any workspace: browse and
 * download, and with an editor grant upload, create folders, rename, move and trash inside the
 * granted folder. `scopeOrgId` is the session's scope (ADR 0024): with one, only grants to an
 * address on that company's claimed domains count.
 */
export function userStorage(db: Db, userId: string, scopeOrgId?: string | null) {
  const door = grantDoor(userId, scopeOrgId);
  return {
    ...treeOperations(db, door),
    ...uploadOperations(db, door),
    /** "Shared with me": every live node granted to the person, newest grant first. */
    async sharedWithMe(page: { cursor?: SharedWithMeCursor | null; limit?: number } = {}) {
      return listSharedWith(db, await grantAddresses(db, userId, scopeOrgId), page);
    },
  };
}

/**
 * The link door. What anyone holding `/s/<shareId>` may read while the link is open to anyone:
 * the shared node and, for a folder, everything inside it. Read only.
 */
export function publicStorage(db: Db, shareId: string) {
  const { node, nodeByShareId, list, file } = treeOperations(db, linkDoor(shareId));
  return {
    /** The shared node itself, or a node inside it. Null when the link opens nothing. */
    node: (nodeId?: string) => (nodeId ? node(nodeId) : nodeByShareId(shareId)),
    /** The contents of the shared folder, or of a folder inside it. */
    async list(page: { parentId?: string; cursor?: StorageListCursor | null; limit?: number }) {
      const parentId = page.parentId ?? (await nodeByShareId(shareId))?.node.id;
      return parentId ? list({ parentId }, page) : ({ status: "not_found" } as const);
    },
    file,
  };
}

/** The node a link opens for anyone, or null: the shared node itself, or `nodeId` inside it. */
export function publicStorageNode(db: Db, shareId: string, nodeId?: string) {
  return publicStorage(db, shareId).node(nodeId);
}

export type MemberStorage = ReturnType<typeof memberStorage>;
export type UserStorage = ReturnType<typeof userStorage>;
export type PublicStorage = ReturnType<typeof publicStorage>;

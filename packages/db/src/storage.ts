import type { Db } from "./client.ts";
import { grantAddresses, grantDoor, linkDoor, loadMember, memberDoor } from "./storage/access.ts";
import type { StorageListCursor, StorageSpace } from "./storage/core.ts";
import { storagePeakOf } from "./storage/billing.ts";
import { commentOperations } from "./storage/comments.ts";
import { findOperations } from "./storage/find.ts";
import { iconOperations } from "./storage/icons.ts";
import { lockOperations } from "./storage/lock.ts";
import { storageUsageOf } from "./storage/maintenance.ts";
import { listSharedWith, sharingOperations, type SharedWithMeCursor } from "./storage/sharing.ts";
import { signerOperations } from "./storage/signer.ts";
import { signingOperations } from "./storage/signing.ts";
import { listChanges, listSyncWorkspaces, type StorageSyncCursor } from "./storage/sync.ts";
import { trashOperations } from "./storage/trash.ts";
import { treeOperations } from "./storage/tree.ts";
import { uploadOperations } from "./storage/uploads.ts";
import { versionOperations } from "./storage/versions.ts";

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
  StorageGuard,
  StoragePathEntry,
  StoragePlace,
  TrashResult,
} from "./storage/tree.ts";
export {
  STORAGE_TOMBSTONE_DAYS,
  sweepStorageTombstones,
  type StorageChange,
  type StorageChangesResult,
  type StorageSyncCursor,
  type StorageSyncDrive,
  type StorageSyncWorkspace,
} from "./storage/sync.ts";
export type { IconResult } from "./storage/icons.ts";
export type { StorageLockResult } from "./storage/lock.ts";
export type {
  AddCommentResult,
  CommentResult,
  CommentsResult,
  DeleteCommentResult,
  StorageComment,
  StorageCommentAnchor,
} from "./storage/comments.ts";
export {
  STORAGE_VERSION_DAYS,
  type RestoreVersionResult,
  type StorageContent,
  type StorageVersion,
  type VersionsResult,
} from "./storage/versions.ts";
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
  type OpenVersionUploadResult,
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
export {
  STORAGE_MAX_SIGNERS,
  STORAGE_PDF_MIME,
  type SendForSignatureResult,
  type SignatureRequestResult,
  type StorageSignatureEvent,
  type StorageSignatureEventKind,
  type StorageSignatureRequest,
  type StorageSignatureStatus,
  type StorageSigner,
  type StorageSigningOrigin,
} from "./storage/signing.ts";
export {
  STORAGE_SIGNING_CODE_TTL_MS,
  type SignResult,
  type SigningCodeResult,
  type StorageSigningItem,
} from "./storage/signer.ts";
export {
  recordStorageSeal,
  sealedObject,
  sealedName,
  storageSealInput,
  unsealedSignatureRequests,
  type RecordSealResult,
  type StorageSealInput,
} from "./storage/seal.ts";
export { handOverMemberStorage, type StorageHandOverResult } from "./storage/handover.ts";
export {
  deletedStorageWorkspaces,
  deleteWorkspaceStorage,
  purgeStorageTrash,
  purgeStorageVersions,
  randomStorageSweepStart,
  recomputeStorageUsage,
  storageUsageOf,
} from "./storage/maintenance.ts";
export {
  noteSubscriptionPaymentMethod,
  raiseStoragePeak,
  setStorageOverage,
  storageBilledWorkspaces,
  storageOverageOf,
  storagePeakOf,
  type StorageBilledWorkspace,
} from "./storage/billing.ts";
export type { StorageUploadPart } from "./schema/storage.ts";

/**
 * The member door. Everything a member does in their workspace's Storage: browse and change
 * their own My files and (in a company) Shared, upload, trash and restore, share, lock, and send
 * for signature. No function here reaches another member's My files, whatever the caller's role.
 */
export function memberStorage(db: Db, memberId: string) {
  const door = memberDoor(memberId);
  return {
    ...treeOperations(db, door),
    ...uploadOperations(db, door),
    ...versionOperations(db, door),
    ...commentOperations(db, door),
    ...findOperations(db, door),
    ...iconOperations(db, door),
    ...trashOperations(db, door, memberId),
    ...sharingOperations(db, door),
    ...lockOperations(db, door, memberId),
    ...signingOperations(db, door, memberId),
    async changes(
      space: StorageSpace,
      page: { cursor?: StorageSyncCursor | null; limit?: number } = {},
    ) {
      const drive = await door.root(db, space);
      return drive ? listChanges(db, drive, page) : ({ status: "not_found" } as const);
    },
    async usage() {
      const member = await loadMember(db, memberId);
      return member ? storageUsageOf(db, member.orgId) : null;
    },
    async peak(periodStart: Date) {
      const member = await loadMember(db, memberId);
      return member ? storagePeakOf(db, member.orgId, periodStart) : null;
    },
  };
}

/**
 * The grant door. What was shared with the person by address, in any workspace: browse and
 * download, with a commenter grant comment too, and with an editor grant upload, create folders,
 * rename, move and trash inside the granted folder. `scopeOrgId` is the session's scope (ADR 0024): with one, only grants to an
 * address on that company's claimed domains count.
 */
export function userStorage(db: Db, userId: string, scopeOrgId?: string | null) {
  const through = (shareId?: string) => {
    const door = grantDoor(userId, scopeOrgId, shareId);
    return {
      ...treeOperations(db, door),
      ...uploadOperations(db, door),
      ...versionOperations(db, door),
      ...commentOperations(db, door),
    };
  };
  return {
    ...through(),
    ...signerOperations(db, userId, scopeOrgId),
    under: (shareId: string) => through(shareId),
    syncWorkspaces: () => listSyncWorkspaces(db, userId, scopeOrgId),
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
    node: (nodeId?: string) => (nodeId ? node(nodeId) : nodeByShareId(shareId)),
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
/** The grant door bounded to one link: `forUser(...).storage.under(shareId)`. */
export type SharedStorage = ReturnType<UserStorage["under"]>;
export type PublicStorage = ReturnType<typeof publicStorage>;

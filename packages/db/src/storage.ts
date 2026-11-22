import type { Db } from "./client.ts";
import { archiveOperations } from "./storage/archive.ts";
import {
  grantAddresses,
  grantDoor,
  linkDoor,
  loadMember,
  memberDoor,
  type LinkVisitor,
} from "./storage/access.ts";
import { inTrash, type StorageListCursor, type StorageSpace } from "./storage/core.ts";
import { storagePeakOf } from "./storage/billing.ts";
import { commentOperations } from "./storage/comments.ts";
import { contextOperations } from "./storage/context.ts";
import { findOperations } from "./storage/find.ts";
import { iconOperations } from "./storage/icons.ts";
import { lockOperations } from "./storage/lock.ts";
import { storageUsageOf } from "./storage/maintenance.ts";
import {
  listSharedWith,
  policyOperations,
  sharingOperations,
  type SharedWithMeCursor,
} from "./storage/sharing.ts";
import { signerOperations } from "./storage/signer.ts";
import { signingOperations } from "./storage/signing.ts";
import { listChanges, listSyncWorkspaces, type StorageSyncCursor } from "./storage/sync.ts";
import { teamspaceOperations } from "./storage/teamspaces.ts";
import { trashOperations } from "./storage/trash.ts";
import {
  reach,
  treeOperations,
  type FileResult,
  type ListResult,
  type StorageNodeView,
} from "./storage/tree.ts";
import type { ArchiveResult } from "./storage/archive.ts";
import { uploadLinkOperations } from "./storage/upload-links.ts";
import { uploadOperations } from "./storage/uploads.ts";
import { versionOperations } from "./storage/versions.ts";

/** The addresses a person's grants and signatures are matched on, for this session. */
export { grantAddresses as storageAddresses } from "./storage/access.ts";
export {
  STORAGE_MAX_DEPTH,
  STORAGE_NAME_MAX_LENGTH,
  storageObjectKey,
  type StorageListCursor,
  type StorageNode,
  type StorageNodeKind,
  type StorageSpace,
} from "./storage/core.ts";
export type { ArchiveResult, StorageArchiveEntry } from "./storage/archive.ts";
export {
  linkState,
  storagePolicyOf,
  type LinkState,
  type LinkVisitor,
  type StoragePolicy,
  type StorageRole,
} from "./storage/access.ts";
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
  STORAGE_SESSION_IDLE_MS,
  STORAGE_SESSION_MS,
  STORAGE_SUPERSEDED_MS,
  addCoauthors,
  foldContent,
  mergeCoauthors,
  type FoldContentResult,
  type StorageWriter,
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
  STORAGE_UPLOAD_MAX_AGE_MS,
  STORAGE_UPLOAD_TTL_MS,
  type AbortUploadResult,
  type CompleteUploadResult,
  type MoveUploadResult,
  type OpenUploadResult,
  type OpenVersionUploadResult,
  type RecordPartResult,
  type StorageFull,
  type StorageUpload,
  type TooManyUploads,
  type UploadCaps,
} from "./storage/uploads.ts";
export {
  openUploadLink,
  uploadingIn,
  uploadLinkOf,
  UPLOADING_LISTED,
  type OpenUploadLinkResult,
  type UploadingFile,
} from "./storage/upload-links.ts";
export {
  linkOf,
  recordShareEvent,
  type PolicyResult,
  type ShareEventInput,
  type StorageLink,
  type StorageLinkSettings,
  type PutGrantResult,
  type RemoveGrantResult,
  type SharedWithMeCursor,
  type SharedWithMeItem,
  type SharingResult,
  type StorageGrantRole,
  type StorageLinkAccess,
  type StoragePerson,
  type StorageSharing,
} from "./storage/sharing.ts";
export {
  STORAGE_MAX_SIGNERS,
  STORAGE_PDF_MIME,
  closedSignatureRequestIds,
  storageSignatureRequestsById,
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
  issueSigningLinks,
  linkSigner,
  STORAGE_SIGNING_LINK_TTL_MS,
} from "./storage/signing-link.ts";
export {
  recordStorageSeal,
  sealedObject,
  sealedName,
  storageSealInput,
  unsealedSignatureRequests,
  type RecordSealResult,
  type StorageSealInput,
} from "./storage/seal.ts";
export {
  STORAGE_CONTEXT_SEARCH_MAX,
  type ContextFile,
  type ContextHit,
  type ContextNode,
  type ContextRead,
  type ContextText,
  type ContextWorkspace,
  type StorageContext,
} from "./storage/context.ts";
export {
  saveStorageText,
  storageFilesToRead,
  STORAGE_TEXT_MAX_ATTEMPTS,
  type StorageFileToRead,
  type StorageTextInput,
  type StorageTextStatus,
} from "./storage/texts.ts";
export { handOverMemberStorage, type StorageHandOverResult } from "./storage/handover.ts";
export { teamspaceFileAudience } from "./storage/audience.ts";
export {
  teamspaceAudience,
  type DeleteTeamspaceResult,
  type NewTeamspace,
  type StorageTeamspace,
  type StorageTeamspaceMember,
  type StorageTeamspaceRole,
  type TeamspaceMembersResult,
  type TeamspaceResult,
} from "./storage/teamspaces.ts";
export {
  deletedStorageWorkspaces,
  deleteWorkspaceStorage,
  purgeStorageTrash,
  purgeStorageVersions,
  randomStorageSweepStart,
  recomputeStorageUsage,
  storageUsageOf,
  orgHoldsFiles,
  grantsForUserRow,
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
export type { StorageCoauthor, StorageGuest, StorageUploadPart } from "./schema/storage.ts";

/**
 * The member door. Everything a member does in their workspace's Storage: browse and change
 * their own My files and (in a company) Shared, upload, trash and restore, share, lock, and send
 * for signature. No function here reaches another member's My files, whatever the caller's role.
 */
export function memberStorage(db: Db, memberId: string) {
  const door = memberDoor(memberId);
  return {
    ...treeOperations(db, door),
    ...archiveOperations(db, door),
    ...uploadOperations(db, door),
    ...versionOperations(db, door),
    ...commentOperations(db, door),
    ...findOperations(db, door),
    ...iconOperations(db, door),
    ...trashOperations(db, door, memberId),
    ...sharingOperations(db, door),
    ...uploadLinkOperations(db, door),
    ...policyOperations(db, memberId),
    ...lockOperations(db, door, memberId),
    ...signingOperations(db, door, memberId),
    ...teamspaceOperations(db, () => loadMember(db, memberId)),
    async changes(
      space: Exclude<StorageSpace, "teamspace">,
      page: { cursor?: StorageSyncCursor | null; limit?: number } = {},
    ) {
      const drive = await door.root(db, space);
      return drive ? listChanges(db, drive, memberId, page) : ({ status: "not_found" } as const);
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
 * rename, move and trash inside the granted folder. `scopeOrgId` is the session's scope: with one, only grants to an
 * address on that company's claimed domains count.
 */
export function userStorage(db: Db, userId: string, scopeOrgId?: string | null) {
  const through = (shareId?: string) => {
    const door = grantDoor(userId, scopeOrgId, shareId);
    return {
      ...treeOperations(db, door),
      ...archiveOperations(db, door),
      ...uploadOperations(db, door),
      ...versionOperations(db, door),
      ...commentOperations(db, door),
    };
  };
  return {
    ...through(),
    ...signerOperations(db, userId, scopeOrgId),
    under: (shareId: string) => through(shareId),
    async linkOf(nodeId: string) {
      const found = await reach(db, grantDoor(userId, scopeOrgId), nodeId);
      return found && !inTrash(found.chain)
        ? (found.chain[found.access.top]?.shareId ?? null)
        : null;
    },
    context: contextOperations(db, userId, scopeOrgId),
    syncWorkspaces: () => listSyncWorkspaces(db, userId, scopeOrgId),
    async sharedWithMe(page: { cursor?: SharedWithMeCursor | null; limit?: number } = {}) {
      return listSharedWith(db, await grantAddresses(db, userId, scopeOrgId), page);
    },
  };
}

/**
 * The link door. What anyone holding `/s/<shareId>` may read while the link is open to anyone:
 * the shared node and, for a folder, everything inside it. No file changes through it; a link
 * whose role is Commenter or Editor lets its guest (`visitor.guest`) comment as themselves.
 */
export function publicStorage(db: Db, shareId: string, visitor?: LinkVisitor) {
  const door = linkDoor(shareId, visitor);
  const { node, nodeByShareId, list, file } = treeOperations(db, door);
  return {
    ...archiveOperations(db, door),
    ...commentOperations(db, door),
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

/**
 * A request made through a share link (`/api/storage/shared/:shareId`): what the link carries,
 * and the door that opened it. The member door, when the signed-in person reaches the item as a
 * member of its workspace; else a grant, when they have one; else the link itself.
 */
export interface SharedAccess {
  /** The node carrying the link. */
  root: StorageNodeView;
  node(nodeId: string): Promise<StorageNodeView | null>;
  list(
    parentId: string,
    page: { cursor?: StorageListCursor | null; limit?: number },
  ): Promise<ListResult>;
  file(nodeId: string): Promise<FileResult>;
  /** The selection as zip entries, through the same door as `file`. */
  archive(nodeIds: string[], max: number): Promise<ArchiveResult>;
  /** The member or grant door that opened it, for changes. A link alone never writes. */
  writer: MemberStorage | SharedStorage | null;
  /** The door that opened it, as the sharing audit records it. */
  via: "member" | "grant" | "link";
  /** False when the link alone opened it and the link is view only: no bytes leave. */
  downloads: boolean;
}

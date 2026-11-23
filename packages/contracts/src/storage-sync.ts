import { z } from "zod";
import {
  storageChangedEventSchema,
  storageChangeNodeBodySchema,
  storageCreateFolderBodySchema,
  storageListResponseSchema,
  storageNodeResponseSchema,
  storageNodeSchema,
  storageNodeSpaceSchema,
  storageNodeViewSchema,
  storageOpenUploadBodySchema,
  storageOpenVersionBodySchema,
  storagePageQuerySchema,
  storageSpaceSchema,
  storageUploadResponseSchema,
  storageUsageSchema,
} from "./storage.ts";

const id = z.string().min(1);

/**
 * A drive the person can sync, and its revision now. A provider compares it with the revision it
 * last saw here to know the drive changed; a changes cursor is opaque and is not comparable.
 */
export const storageSyncDriveSchema = z.object({
  space: storageSpaceSchema,
  revision: z.number().int().nonnegative(),
});

/** A teamspace the person is in, synced as a folder of its own, and its revision now. */
export const storageSyncTeamspaceSchema = storageSyncDriveSchema
  .omit({ space: true })
  .extend({ id, name: z.string() });

export const storageSyncWorkspaceSchema = z.object({
  orgId: id,
  name: z.string(),
  /** `personal`, and `shared` in a company. */
  drives: z.array(storageSyncDriveSchema),
  /** The teamspaces the person is in, by name. Absent from an older Worker. */
  teamspaces: z.array(storageSyncTeamspaceSchema).optional(),
});

/** `GET /sync/drives`: every workspace the person belongs to, and its drives. */
export const storageSyncDrivesResponseSchema = z.object({
  workspaces: z.array(storageSyncWorkspaceSchema),
});

/**
 * `GET /sync/:orgId/changes?space=&cursor=&limit=`, or `?teamspace=` for a teamspace's feed.
 * No cursor: the whole drive, paged. `teamspaces=1` says the caller syncs the teamspaces it is
 * in: a node that moved into one of them is not `gone` for it.
 */
export const storageSyncChangesQuerySchema = storagePageQuerySchema
  .extend({
    space: storageSpaceSchema.optional(),
    teamspace: id.optional(),
    teamspaces: z.literal("1").optional(),
  })
  .refine(
    (query) => (query.space === undefined) !== (query.teamspace === undefined),
    "give space or teamspace",
  );

/**
 * One change to a drive, in revision order. `node` is the node as it is now. `inTrash` says
 * whether it is in Trash, itself or under a trashed folder (only the folder trashed carries
 * `trashedAt`): report it as a deletion, and a restore arrives later as a change with it false.
 * `node: null` is a tombstone: the node left this drive for good (deleted forever, purged from
 * Trash, or moved to another drive); `inTrash` is then false. A tombstone's `gone` is true when
 * the node is gone for the caller (deleted, or moved to a drive they don't sync) and false when
 * it moved to another drive they sync, whose changes report it; a tombstone without `gone` (from an
 * older Worker) has to be looked up.
 */
export const storageSyncChangeSchema = z.object({
  id,
  revision: z.number().int().nonnegative(),
  node: storageNodeSchema.nullable(),
  inTrash: z.boolean(),
  gone: z.boolean().optional(),
});

/**
 * The page's changes and the cursor to store once they are applied. `more`: ask again with it
 * now. A cursor older than tombstone retention answers `410 cursor_expired`: start over without
 * one.
 */
export const storageSyncChangesResponseSchema = z.object({
  changes: z.array(storageSyncChangeSchema),
  nextCursor: z.string().min(1),
  more: z.boolean(),
});

/**
 * Where Drive sync stands for one workspace on this computer, as Settings → Drive shows it: `off`
 * (the default, since it puts a folder in Finder), `synced`, `syncing`, `paused` from the tray,
 * or `needs_attention` (sign in again, storage full).
 */
export const desktopSyncStateSchema = z.enum([
  "off",
  "synced",
  "syncing",
  "paused",
  "needs_attention",
]);

export const desktopWorkspaceSyncSchema = z.object({ orgId: id, state: desktopSyncStateSchema });

/**
 * The desktop shell's `sync_status` command (not HTTP: Tauri IPC from the web app). `available`
 * is false where the build has no sync provider. `sync_connect` and `sync_disconnect` take
 * `{ orgId }` and answer a `desktopWorkspaceSyncSchema`.
 */
export const desktopSyncStatusSchema = z.object({
  available: z.boolean(),
  workspaces: z.array(desktopWorkspaceSyncSchema),
});

/**
 * What `omni-sync` (the macOS shell's sync helper) prints for
 * `sign-in`: the authorize URL the shell opens in the app window.
 */
export const desktopSyncSignInSchema = z.object({ url: z.string() });

/**
 * The desktop sync grant as the macOS app keeps it in the keychain group it shares with the File
 * Provider extension, and as `omni-sync finish-sign-in` hands it to the app. `expiresAt` is Unix
 * seconds.
 */
export const desktopSyncTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

/** What `omni-sync` prints for a command that answers only that it worked. */
export const desktopSyncDoneSchema = z.object({ ok: z.literal(true) });

/** The schemas the native sync providers are generated from, by the name their type takes. */
export const STORAGE_SYNC_NATIVE_TYPES = {
  Space: storageSpaceSchema,
  StorageNodeSpace: storageNodeSpaceSchema,
  StorageNode: storageNodeSchema,
  StorageNodeView: storageNodeViewSchema,
  StorageListResponse: storageListResponseSchema,
  StorageNodeResponse: storageNodeResponseSchema,
  StorageCreateFolderBody: storageCreateFolderBodySchema,
  StorageChangeNodeBody: storageChangeNodeBodySchema,
  StorageOpenUploadBody: storageOpenUploadBodySchema,
  StorageOpenVersionBody: storageOpenVersionBodySchema,
  StorageUploadResponse: storageUploadResponseSchema,
  StorageUsage: storageUsageSchema,
  StorageSyncDrive: storageSyncDriveSchema,
  StorageSyncTeamspace: storageSyncTeamspaceSchema,
  StorageSyncWorkspace: storageSyncWorkspaceSchema,
  StorageSyncDrivesResponse: storageSyncDrivesResponseSchema,
  StorageSyncChange: storageSyncChangeSchema,
  StorageSyncChangesResponse: storageSyncChangesResponseSchema,
  StorageChangedEvent: storageChangedEventSchema,
  DesktopSyncState: desktopSyncStateSchema,
  DesktopWorkspaceSync: desktopWorkspaceSyncSchema,
  DesktopSyncStatus: desktopSyncStatusSchema,
  DesktopSyncSignIn: desktopSyncSignInSchema,
  DesktopSyncDone: desktopSyncDoneSchema,
  DesktopSyncTokens: desktopSyncTokensSchema,
} as const;

export type StorageSyncDrive = z.infer<typeof storageSyncDriveSchema>;
export type StorageSyncWorkspace = z.infer<typeof storageSyncWorkspaceSchema>;
export type StorageSyncDrivesResponse = z.infer<typeof storageSyncDrivesResponseSchema>;
export type StorageSyncChangesQuery = z.infer<typeof storageSyncChangesQuerySchema>;
export type StorageSyncChange = z.infer<typeof storageSyncChangeSchema>;
export type StorageSyncChangesResponse = z.infer<typeof storageSyncChangesResponseSchema>;
export type DesktopSyncState = z.infer<typeof desktopSyncStateSchema>;
export type DesktopWorkspaceSync = z.infer<typeof desktopWorkspaceSyncSchema>;
export type DesktopSyncStatus = z.infer<typeof desktopSyncStatusSchema>;

import { z } from "zod";

/** Bytes in every part of an upload but the last (R2 wants them uniform). */
export const STORAGE_PART_BYTES = 16 * 1024 * 1024;
/** R2's cap on the parts of one upload. */
export const STORAGE_MAX_PARTS = 10_000;

/** `personal` is the member's My files; `shared` is the company's shared drive. */
export const storageSpaceSchema = z.enum(["personal", "shared"]);
export const storageNodeKindSchema = z.enum(["folder", "file"]);
/**
 * `member` is someone in the node's space; the others come from a grant or a link. A `commenter`
 * reads and writes comments (ADR 0043 decision 5); absent from a Worker older than comments.
 */
export const storageRoleSchema = z.enum(["member", "editor", "commenter", "viewer"]);
export const storageGrantRoleSchema = z.enum(["viewer", "commenter", "editor"]);
export const storageLinkAccessSchema = z.enum(["restricted", "anyone"]);

const isoDate = z.iso.datetime();
const id = z.string().min(1);
const name = z.string().min(1).max(255);

/** The glyphs a folder may take in Drive's sidebar instead of the folder (ADR 0047). */
export const STORAGE_FOLDER_ICONS = [
  "rocket",
  "star",
  "heart",
  "sparkle",
  "light-bulb",
  "target",
  "trophy",
  "megaphone",
  "analytics",
  "coins",
  "buildings",
  "globe",
  "home",
  "book",
  "code",
  "brush",
  "video",
  "archive",
  "package",
  "lock",
] as const;
export const storageFolderIconSchema = z.enum(STORAGE_FOLDER_ICONS);

export const storageNodeSchema = z.object({
  id,
  orgId: id,
  space: storageSpaceSchema,
  /** Whose My files it is in; null in Shared. */
  ownerMemberId: id.nullable(),
  /** Null at the root of its space. */
  parentId: id.nullable(),
  kind: storageNodeKindSchema,
  name: z.string(),
  /** 0 for a folder. */
  size: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  createdByMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** Set on the node that was moved to Trash. */
  trashedAt: isoDate.nullable(),
  /**
   * Set on a locked file: it cannot be renamed, moved, trashed or deleted until unlocked. Absent
   * from a Worker older than the lock.
   */
  lockedAt: isoDate.nullable().optional(),
  /**
   * Sync (ADR 0043): the drive's revision when the row last changed in any way. Absent from a
   * Worker older than sync.
   */
  revision: z.number().int().nonnegative().optional(),
  /** Goes up each time a file's bytes are replaced; constant for a folder. Absent as above. */
  contentVersion: z.number().int().nonnegative().optional(),
  /** Hex sha256 of the bytes, as the uploading client sent it; null when it sent none. */
  contentSha256: z.string().nullable().optional(),
});

/** A node as its reader sees it. `path` runs from the highest folder they can open to the node. */
export const storageNodeViewSchema = z.object({
  node: storageNodeSchema,
  role: storageRoleSchema,
  path: z.array(z.object({ id, name: z.string() })),
});

const page = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
};

const place = { parentId: id.optional(), space: storageSpaceSchema.optional() };
const onePlace = [
  (value: { parentId?: string; space?: string }) =>
    (value.parentId === undefined) !== (value.space === undefined),
  { message: "give either parentId or space" },
] as const;

/** `GET /nodes?space=&parent=`: a folder's contents, folders first, then by name. */
export const storageListQuerySchema = z
  .object({ space: storageSpaceSchema.optional(), parent: id.optional(), ...page })
  .refine((query) => (query.parent === undefined) !== (query.space === undefined), {
    message: "give either parent or space",
  });
export const storageListResponseSchema = z.object({
  /** The folder listed; null at the root of a space. */
  folder: storageNodeViewSchema.nullable(),
  nodes: z.array(storageNodeSchema),
  nextCursor: z.string().nullable(),
});

/** `POST /folders`. A taken name gets a number. Answers `{ node }`. */
export const storageCreateFolderBodySchema = z.object({ name, ...place }).refine(...onePlace);

/**
 * `PATCH /nodes/:id`: a new name, a new place in the same workspace, or a folder's sidebar glyph
 * (null clears it). Answers `{ node }`.
 */
export const storageChangeNodeBodySchema = z.union([
  z.strictObject({ name }),
  z.strictObject({ icon: storageFolderIconSchema.nullable() }),
  z.strictObject(place).refine(...onePlace),
]);

/** `DELETE /nodes/:id`: to Trash, or with `forever=1` out of Trash for good. */
export const storageDeleteQuerySchema = z.object({ forever: z.literal("1").optional() });

export const storageNodeResponseSchema = z.object({ node: storageNodeSchema });

/** `GET /trash`: what the member may restore, newest first. */
export const storagePageQuerySchema = z.object(page);
export const storageTrashResponseSchema = z.object({
  nodes: z.array(storageNodeSchema),
  nextCursor: z.string().nullable(),
});

/** `GET /search?q=`: what a name holds, ignoring case. */
export const storageSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(255) });
/**
 * Drive's `GET /search`, folders first, then by name: live nodes across the member's My files
 * and, in a company, Shared. Not paged.
 */
export const storageFindResponseSchema = z.object({ nodes: z.array(storageNodeSchema) });

/**
 * Drive's `GET /icons?space=`: the chosen glyphs of a drive's top-level folders, by folder id. A
 * folder without one is absent. Strings, not the enum, so an older client still reads a new glyph.
 */
export const storageFolderIconsQuerySchema = z.object({ space: storageSpaceSchema });
export const storageFolderIconsResponseSchema = z.object({
  icons: z.record(z.string(), z.string()),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** `POST /uploads`: opens an upload of `size` bytes. `sha256` is the bytes' hash, if known. */
export const storageOpenUploadBodySchema = z
  .object({
    name,
    size: z.number().int().nonnegative(),
    mimeType: z.string().max(255).nullish(),
    sha256: sha256.optional(),
    ...place,
  })
  .refine(...onePlace);

/**
 * An upload in progress. The file goes up as `partCount` parts numbered from 1, each
 * `partSize` bytes but the last, to `PUT /uploads/:id/parts/:n` (raw bytes, with
 * `content-length`), in any order and several at once. `parts` are those already stored: after a
 * dropped connection, `GET /uploads/:id` and send the rest. A part may be sent again.
 */
export const storageUploadSchema = z.object({
  id,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  space: storageSpaceSchema,
  parentId: id.nullable(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().nonnegative(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), size: z.number().int() })),
  expiresAt: isoDate,
  /** The file it became, once completed. */
  nodeId: id.nullable(),
});
export const storageUploadResponseSchema = z.object({ upload: storageUploadSchema });

/** `POST /uploads/:id/complete?ifContentVersion=`: a checked save's base, checked again. */
export const storageCompleteUploadQuerySchema = z.object({
  ifContentVersion: z.coerce.number().int().nonnegative().optional(),
});

export const storageOpenVersionBodySchema = z.object({
  size: z.number().int().nonnegative(),
  mimeType: z.string().max(255).nullish(),
  sha256: sha256.optional(),
  ifContentVersion: z.number().int().nonnegative().optional(),
});

const storageContentSchema = z.object({
  size: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  writtenAt: isoDate,
  writtenByName: z.string().nullable(),
});
export const storageVersionSchema = storageContentSchema.extend({ id, replacedAt: isoDate });

/**
 * `GET /files/:id/versions`: the file's current content and the versions it replaced, newest
 * first. `GET /files/:id/versions/:versionId/content` downloads one, and
 * `POST /files/:id/versions/:versionId/restore` makes it the current content again (answers
 * `{ node }`); the content it displaces becomes a version. Editors only, like the upload.
 */
export const storageVersionsResponseSchema = z.object({
  current: storageContentSchema,
  versions: z.array(storageVersionSchema),
  /** Days a replaced version is kept before it is deleted for good. */
  keepDays: z.number().int().positive(),
});

/** `GET /usage`. */
export const storageUsageSchema = z.object({
  /** Bytes stored, files in Trash included. */
  usedBytes: z.number().int().nonnegative(),
  /** Declared bytes of uploads in progress; they count against the limit too. */
  reservedBytes: z.number().int().nonnegative(),
  /** Bytes the plan includes before extra storage is billed; null when there is no plan. */
  allowanceBytes: z.number().nonnegative().nullable(),
  /** Bytes nothing passes; null when there is no cap. */
  limitBytes: z.number().nonnegative().nullable(),
  /**
   * Set when storage past the allowance is billed instead of refused: the whole GB above the
   * allowance this usage month's peak comes to so far. Null (or absent, from a Worker that
   * predates it): nothing extra is billed.
   */
  overage: z.object({ extraGb: z.number().int().nonnegative() }).nullable().optional(),
  /** Why an upload would be refused now, or null when it would not. */
  uploadsBlocked: z.enum(["storage_full", "billing_inactive"]).nullable(),
});

export const storagePersonSchema = z.object({
  email: z.string(),
  role: storageGrantRoleSchema,
  createdAt: isoDate,
});

/** `GET /nodes/:id/sharing`, and the answer to every change to it. */
export const storageSharingSchema = z.object({
  nodeId: id,
  /** Null until the node is first shared. The link is `/s/<shareId>` in both modes. */
  shareId: z.string().nullable(),
  linkAccess: storageLinkAccessSchema,
  people: z.array(storagePersonSchema),
  /** People who reach the node through a folder above it. */
  inherited: z.array(storagePersonSchema.extend({ nodeId: id, nodeName: z.string() })),
});
export const storageSharingResponseSchema = z.object({ sharing: storageSharingSchema });

/** `PUT /nodes/:id/sharing/link`: set general access, or `reset` for a new link. */
export const storageSetLinkBodySchema = z.union([
  z.strictObject({ linkAccess: storageLinkAccessSchema }),
  z.strictObject({ reset: z.literal(true) }),
]);

/** A person's address as a grant stores it: trimmed and lowercase. `:email` in the routes below. */
export const storageEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));

/**
 * `PUT /nodes/:id/sharing/people/:email`: add the person, or change their role. Adding sends them
 * one mail with the link; a role change sends none. `DELETE` the same removes them. Both answer
 * `{ sharing }`. Only a member who can write the node manages its sharing.
 */
export const storagePutPersonBodySchema = z.object({ role: storageGrantRoleSchema });

/** `GET /shared-with-me`: what was shared with the signed-in person, newest first. */
export const storageSharedWithMeItemSchema = z.object({
  node: storageNodeSchema,
  role: storageGrantRoleSchema,
  /** The node's link: `/s/<shareId>` opens it. */
  shareId: z.string().nullable(),
  /** The workspace it lives in. */
  orgName: z.string(),
  sharedAt: isoDate,
});
export const storageSharedWithMeResponseSchema = z.object({
  items: z.array(storageSharedWithMeItemSchema),
  nextCursor: z.string().nullable(),
});

/**
 * `GET /shared/:shareId?node=`: the shared node, or a folder inside it. This is what `/s/<shareId>`
 * opens. Without a session it answers only while the link is open to anyone; with one, also for a
 * person the node was shared with. Anything else is `404`. `item.role` says what the reader may do.
 *
 * The rest of what was shared is reached under the same prefix, by the same shapes as a member's
 * own routes: `GET /shared/:shareId/files/:id/content` downloads, and for an Editor
 * `POST /shared/:shareId/folders`, `PATCH` and `DELETE /shared/:shareId/nodes/:id` and
 * `/shared/:shareId/uploads...` change what is inside the shared folder (always by `parentId`:
 * a link has no `space`). A change goes by the shared node's workspace: `402 billing_inactive`
 * when that workspace is read-only, whatever the reader's own.
 */
export const storageSharedQuerySchema = z.object({ node: id.optional(), ...page });
export const storageSharedResponseSchema = z.object({
  /** The node opened: the shared one, or `node` inside it. */
  item: storageNodeViewSchema,
  /** Its contents when it is a folder; empty for a file. */
  nodes: z.array(storageNodeSchema),
  nextCursor: z.string().nullable(),
});

/**
 * The sentence a signer accepts, with its version. A signer sends the version back; one that is
 * not the current version answers `409 consent_changed`, so nobody signs under words they did not
 * see. Changing the words means a new version.
 */
export const STORAGE_SIGNING_CONSENT = {
  version: "2026-11-16",
  text: "I agree to sign this document electronically, and that my typed name is my signature on it.",
} as const;

export const storageSignatureStatusSchema = z.enum(["sent", "completed", "voided"]);

/**
 * `POST /files/:id/signatures`: sends a PDF the member reaches to these addresses, in this order.
 * The Worker hashes the bytes, locks the file and mails each signer a link. Answers
 * `201 { request }`; `415 not_a_pdf`, `409 signature_open` while another request is out on it.
 */
export const storageSendForSignatureBodySchema = z.object({
  signers: z
    .array(z.object({ email: storageEmailSchema, name: z.string().trim().min(1).max(200) }))
    .min(1)
    .max(20)
    .refine((list) => new Set(list.map((s) => s.email)).size === list.length, {
      message: "each address signs once",
    }),
});

const storageSignatureEventSchema = z.object({
  kind: z.enum(["sent", "viewed", "code_sent", "code_verified", "signed", "completed", "voided"]),
  email: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: isoDate,
});

/** A request as its sender sees it: every signer and the whole audit trail. */
export const storageSignatureRequestSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  contentVersion: z.number().int(),
  /** Hex SHA-256 of the bytes sent, computed by the Worker. */
  documentSha256: z.string(),
  status: storageSignatureStatusSchema,
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  voidedAt: isoDate.nullable(),
  /** The signed copy (the PDF with its audit page), a locked file beside the original. */
  sealedNodeId: z.string().nullable(),
  sealedSha256: z.string().nullable(),
  signers: z.array(
    z.object({
      email: z.string(),
      name: z.string(),
      signedAt: isoDate.nullable(),
      typedName: z.string().nullable(),
    }),
  ),
  events: z.array(storageSignatureEventSchema),
});

/** `POST /files/:id/signatures` and `POST /signatures/:requestId/void` answer this. */
export const storageSignatureRequestResponseSchema = z.object({
  request: storageSignatureRequestSchema,
});

/** `GET /files/:id/signatures`: every request made on the file, newest first. */
export const storageSignatureRequestsResponseSchema = z.object({
  requests: z.array(storageSignatureRequestSchema),
});

/**
 * A request as a person asked to sign it sees it, under `/api/storage/signing`: the others by
 * name only. `GET /signing` lists them, `GET /signing/:id` is one, `GET /signing/:id/content` is
 * the document, `POST /signing/:id/code` mails a one-time code and `POST /signing/:id/sign` signs.
 */
export const storageSigningItemSchema = z.object({
  id: z.string(),
  status: storageSignatureStatusSchema,
  fileName: z.string(),
  size: z.number().int(),
  workspaceName: z.string(),
  sentBy: z.string().nullable(),
  createdAt: isoDate,
  documentSha256: z.string(),
  /** The signed copy is ready at `GET /signing/:id/sealed`. */
  sealed: z.boolean(),
  signers: z.array(z.object({ name: z.string(), signed: z.boolean() })),
  me: z.object({ email: z.string(), name: z.string(), signedAt: isoDate.nullable() }),
});

export const storageSigningListResponseSchema = z.object({
  items: z.array(storageSigningItemSchema),
});

/** One request, with the consent sentence a signer accepts (`STORAGE_SIGNING_CONSENT`). */
export const storageSigningItemResponseSchema = z.object({
  item: storageSigningItemSchema,
  consent: z.object({ version: z.string(), text: z.string() }),
});

/** `POST /signing/:id/code` answers when the code mailed stops working. */
export const storageSigningCodeResponseSchema = z.object({ expiresAt: isoDate });

/** `POST /signing/:id/sign`. A wrong or expired code is `400 invalid_code`. */
export const storageSignBodySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  typedName: z.string().trim().min(1).max(200),
  consentVersion: z.string(),
});

/**
 * A drive the person can sync, and its revision now. A provider compares it with the revision it
 * last saw here to know the drive changed; a changes cursor is opaque and is not comparable.
 */
export const storageSyncDriveSchema = z.object({
  space: storageSpaceSchema,
  revision: z.number().int().nonnegative(),
});

export const storageSyncWorkspaceSchema = z.object({
  orgId: id,
  name: z.string(),
  /** `personal`, and `shared` in a company. */
  drives: z.array(storageSyncDriveSchema),
});

/** `GET /sync/drives`: every workspace the person belongs to, and its drives. */
export const storageSyncDrivesResponseSchema = z.object({
  workspaces: z.array(storageSyncWorkspaceSchema),
});

/** `GET /sync/:orgId/changes?space=&cursor=&limit=`. No cursor: the whole drive, paged. */
export const storageSyncChangesQuerySchema = z.object({ space: storageSpaceSchema, ...page });

/**
 * One change to a drive, in revision order. `node` is the node as it is now. `inTrash` says
 * whether it is in Trash, itself or under a trashed folder (only the folder trashed carries
 * `trashedAt`): report it as a deletion, and a restore arrives later as a change with it false.
 * `node: null` is a tombstone: the node left this drive for good (deleted forever, purged from
 * Trash, or moved to the other space); `inTrash` is then false.
 */
export const storageSyncChangeSchema = z.object({
  id,
  revision: z.number().int().nonnegative(),
  node: storageNodeSchema.nullable(),
  inTrash: z.boolean(),
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
 * `POST /uploads` that replaces a file's bytes in place. On complete the node keeps its id, name
 * and sharing, takes the new bytes, and its `contentVersion` goes up. `ifContentVersion` is the
 * version the client read: a newer one on the server answers `409 version_conflict` and stores
 * nothing.
 */
export const storageReplaceUploadBodySchema = z.strictObject({
  replaces: id,
  ifContentVersion: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().max(255).nullish(),
  sha256: sha256.optional(),
});

/**
 * `PATCH /nodes/:id?ifRevision=` and `DELETE /nodes/:id?ifRevision=`: refuse with `409
 * version_conflict` when the node's revision is no longer this one. Without it, unguarded.
 */
export const storageRevisionGuardQuerySchema = z.object({
  ifRevision: z.coerce.number().int().nonnegative().optional(),
});

/**
 * On the workspace's realtime socket (`GET /sync/:orgId/realtime` for a provider): something in
 * this drive changed, so read its changes. Sent after the change commits; it names no node.
 */
export const storageChangedEventSchema = z.object({
  type: z.literal("storage.changed"),
  space: storageSpaceSchema,
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
 * On the workspace's realtime socket for the web app (ADR 0043 decision 3): someone who sees the
 * file is editing it, or stopped. The app sends `{"type":"file.presence","nodeId","state"}`
 * with `editing` while a file is open in its editor (again every 30 s, as a heartbeat) and
 * `left` when it closes; the others who see the file hear this, and a newcomer hears who is
 * already editing. Expire anyone not heard from in 90 s.
 */
export const storageFilePresenceEventSchema = z.object({
  type: z.literal("file.presence"),
  nodeId: id,
  memberId: id,
  state: z.enum(["editing", "left"]),
});

/**
 * Live co-editing (ADR 0043 decision 3 step 2): an open document is one S2 stream of these
 * records, `docs/<nodeId>`. A `seed` starts an epoch: the editor's whole state, made from the file
 * at `contentVersion`. Each `update` (an editor update, base64) and `fold` names its epoch by the
 * seed's sequence number; a `fold` says the epoch up to record `s` was saved as `contentVersion`. An editor joins
 * the latest epoch when the file's content version is that epoch's last one, and seeds a new one
 * otherwise (the file changed outside the live layer).
 */
export const storageLiveRecordSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("seed"), cv: z.number().int().nonnegative(), u: z.base64() }),
  z.object({ t: z.literal("update"), e: z.number().int().nonnegative(), u: z.base64() }),
  z.object({
    t: z.literal("fold"),
    e: z.number().int().nonnegative(),
    cv: z.number().int().nonnegative(),
    /** The last record the saved text held, with every one before it. */
    s: z.number().int().nonnegative(),
  }),
]);

/** One record of the stream, at its sequence number. */
export const storageLiveEntrySchema = z.object({
  seqNum: z.number().int().nonnegative(),
  record: storageLiveRecordSchema,
});

/**
 * `GET /files/:id/live?from=`: the document's records from `from` (0 by default), at most 1000;
 * `more` when there may be others after them. `enabled: false` when the live layer is off: the
 * document edits with checked saves alone.
 */
export const storageLiveReadQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
});
export const storageLiveReadResponseSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    entries: z.array(storageLiveEntrySchema),
    more: z.boolean(),
  }),
]);

/**
 * On the realtime socket, while the socket edits the file (after its `file.presence` `editing`):
 * the app sends `{"type":"doc.append","nodeId","ref","record","matchSeqNum"?}`; `ref` is the app's
 * own number for it. The sender hears `doc.appended` with its sequence number, or `doc.refused`
 * with why: `tail` (a `matchSeqNum` that was no longer the tail: read the stream again),
 * `editing` (the socket's `editing` has not been checked yet, or it is not editing the file: try
 * again after it), `denied` (the member no longer reaches the file), `locked`, or `unavailable` (the live layer is off or failed). The others
 * editing the file hear `doc.record`. Records can arrive out of
 * order and a dropped socket misses some: read the gap with `GET /files/:id/live`.
 */
export const storageDocEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("doc.appended"),
    nodeId: id,
    ref: z.number().int(),
    seqNum: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("doc.refused"),
    nodeId: id,
    ref: z.number().int(),
    reason: z.enum(["tail", "editing", "denied", "locked", "unavailable"]),
  }),
  z.object({
    type: z.literal("doc.record"),
    nodeId: id,
    seqNum: z.number().int().nonnegative(),
    record: storageLiveRecordSchema,
  }),
]);

/**
 * What `omni-sync` (the macOS shell's sync helper, ADR 0043 amendment 1) prints for
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
  StorageNode: storageNodeSchema,
  StorageNodeView: storageNodeViewSchema,
  StorageListResponse: storageListResponseSchema,
  StorageNodeResponse: storageNodeResponseSchema,
  StorageCreateFolderBody: storageCreateFolderBodySchema,
  StorageChangeNodeBody: storageChangeNodeBodySchema,
  StorageOpenUploadBody: storageOpenUploadBodySchema,
  StorageReplaceUploadBody: storageReplaceUploadBodySchema,
  StorageUploadResponse: storageUploadResponseSchema,
  StorageUsage: storageUsageSchema,
  StorageSyncDrive: storageSyncDriveSchema,
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

export type StorageSpace = z.infer<typeof storageSpaceSchema>;
export type StorageChangedEvent = z.infer<typeof storageChangedEventSchema>;
export type StorageFilePresenceEvent = z.infer<typeof storageFilePresenceEventSchema>;
export type StorageLiveRecord = z.infer<typeof storageLiveRecordSchema>;
export type StorageLiveEntry = z.infer<typeof storageLiveEntrySchema>;
export type StorageLiveReadResponse = z.infer<typeof storageLiveReadResponseSchema>;
export type StorageDocEvent = z.infer<typeof storageDocEventSchema>;
export type StorageNodeKind = z.infer<typeof storageNodeKindSchema>;
export type StorageRole = z.infer<typeof storageRoleSchema>;
export type StorageGrantRole = z.infer<typeof storageGrantRoleSchema>;
export type StorageLinkAccess = z.infer<typeof storageLinkAccessSchema>;
export type StorageNode = z.infer<typeof storageNodeSchema>;
export type StorageNodeView = z.infer<typeof storageNodeViewSchema>;
export type StorageListResponse = z.infer<typeof storageListResponseSchema>;
export type StorageNodeResponse = z.infer<typeof storageNodeResponseSchema>;
export type StorageTrashResponse = z.infer<typeof storageTrashResponseSchema>;
export type StorageFindResponse = z.infer<typeof storageFindResponseSchema>;
export type StorageFolderIconsResponse = z.infer<typeof storageFolderIconsResponseSchema>;
export type StorageCreateFolderBody = z.infer<typeof storageCreateFolderBodySchema>;
export type StorageChangeNodeBody = z.infer<typeof storageChangeNodeBodySchema>;
export type StorageOpenUploadBody = z.infer<typeof storageOpenUploadBodySchema>;
export type StorageUpload = z.infer<typeof storageUploadSchema>;
export type StorageUploadResponse = z.infer<typeof storageUploadResponseSchema>;
export type StorageOpenVersionBody = z.infer<typeof storageOpenVersionBodySchema>;
export type StorageVersion = z.infer<typeof storageVersionSchema>;
export type StorageVersionsResponse = z.infer<typeof storageVersionsResponseSchema>;
export type StorageUsage = z.infer<typeof storageUsageSchema>;
export type StoragePerson = z.infer<typeof storagePersonSchema>;
export type StorageSharing = z.infer<typeof storageSharingSchema>;
export type StorageSharingResponse = z.infer<typeof storageSharingResponseSchema>;
export type StorageSetLinkBody = z.infer<typeof storageSetLinkBodySchema>;
export type StoragePutPersonBody = z.infer<typeof storagePutPersonBodySchema>;
export type StorageSharedWithMeItem = z.infer<typeof storageSharedWithMeItemSchema>;
export type StorageSharedWithMeResponse = z.infer<typeof storageSharedWithMeResponseSchema>;
export type StorageSharedResponse = z.infer<typeof storageSharedResponseSchema>;
export type StorageSignatureStatus = z.infer<typeof storageSignatureStatusSchema>;
export type StorageSendForSignatureBody = z.infer<typeof storageSendForSignatureBodySchema>;
export type StorageSignatureRequest = z.infer<typeof storageSignatureRequestSchema>;
export type StorageSignatureRequestResponse = z.infer<typeof storageSignatureRequestResponseSchema>;
export type StorageSignatureRequestsResponse = z.infer<
  typeof storageSignatureRequestsResponseSchema
>;
export type StorageSigningItem = z.infer<typeof storageSigningItemSchema>;
export type StorageSigningListResponse = z.infer<typeof storageSigningListResponseSchema>;
export type StorageSigningItemResponse = z.infer<typeof storageSigningItemResponseSchema>;
export type StorageSigningCodeResponse = z.infer<typeof storageSigningCodeResponseSchema>;
export type StorageSignBody = z.infer<typeof storageSignBodySchema>;
export type StorageSyncDrive = z.infer<typeof storageSyncDriveSchema>;
export type StorageSyncWorkspace = z.infer<typeof storageSyncWorkspaceSchema>;
export type StorageSyncDrivesResponse = z.infer<typeof storageSyncDrivesResponseSchema>;
export type StorageSyncChangesQuery = z.infer<typeof storageSyncChangesQuerySchema>;
export type StorageSyncChange = z.infer<typeof storageSyncChangeSchema>;
export type StorageSyncChangesResponse = z.infer<typeof storageSyncChangesResponseSchema>;
export type StorageReplaceUploadBody = z.infer<typeof storageReplaceUploadBodySchema>;
export type DesktopSyncState = z.infer<typeof desktopSyncStateSchema>;
export type DesktopWorkspaceSync = z.infer<typeof desktopWorkspaceSyncSchema>;
export type DesktopSyncStatus = z.infer<typeof desktopSyncStatusSchema>;

export * from "./storage-comments.ts";

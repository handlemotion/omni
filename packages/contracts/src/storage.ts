import { z } from "zod";
import {
  storageLinkPasswordSchema,
  storageLinkSchema,
  storagePolicySchema,
  storageSharedUploadSchema,
} from "./storage-links.ts";

/** Bytes in every part of an upload but the last (R2 wants them uniform). */
export const STORAGE_PART_BYTES = 16 * 1024 * 1024;
/** R2's cap on the parts of one upload. */
export const STORAGE_MAX_PARTS = 10_000;

/** `personal` is the member's My files; `shared` is the company's shared drive. */
export const storageSpaceSchema = z.enum(["personal", "shared"]);
/**
 * The drive a node is in: `personal` and `shared` as above, or `teamspace`, one of the
 * workspace's teamspaces (`teamspaceId`, `docs/spec/teamspaces.md`).
 */
export const storageNodeSpaceSchema = z.enum(["personal", "shared", "teamspace"]);
export const storageNodeKindSchema = z.enum(["folder", "file"]);
/**
 * `member` is someone in the node's space; the others come from a grant or a link. A `commenter`
 * reads and writes comments; absent from a Worker older than comments.
 */
export const storageRoleSchema = z.enum(["member", "editor", "commenter", "viewer"]);
export const storageGrantRoleSchema = z.enum(["viewer", "commenter", "editor"]);
/**
 * Who a link opens for besides the people it is shared with: nobody (`restricted`), any
 * signed-in member of the node's workspace (`workspace`), or anyone holding it. `workspace` is
 * absent from a Worker older than link settings.
 */
export const storageLinkAccessSchema = z.enum(["restricted", "anyone", "workspace"]);

const isoDate = z.iso.datetime();
const id = z.string().min(1);
const name = z.string().min(1).max(255);

/** The glyphs a folder may take in Drive's sidebar instead of the folder. */
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
  space: storageNodeSpaceSchema,
  /** Whose My files it is in; null in Shared and in a teamspace. */
  ownerMemberId: id.nullable(),
  /** The teamspace it is in; null in My files and Shared. Absent from an older Worker. */
  teamspaceId: id.nullable().optional(),
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
   * Sync: the drive's revision when the row last changed in any way. Absent from a
   * Worker older than sync.
   */
  revision: z.number().int().nonnegative().optional(),
  /** Goes up each time a file's bytes are replaced; constant for a folder. Absent as above. */
  contentVersion: z.number().int().nonnegative().optional(),
  /**
   * Hex sha256 of the bytes as the uploading client sent it, checked against the stored bytes
   * for files up to the Worker's `STORAGE_HASH_CHECK_MAX_BYTES` (a mismatch is refused); null
   * when it sent none.
   */
  contentSha256: z.string().nullable().optional(),
  /**
   * Only the workspace's members see it: a grant or a link on a folder above does not reach in.
   * Absent from a Worker older than it.
   */
  teamOnly: z.boolean().optional(),
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

const place = {
  parentId: id.optional(),
  space: storageSpaceSchema.optional(),
  teamspaceId: id.optional(),
};
const exactlyOne = (...values: unknown[]) => values.filter((v) => v !== undefined).length === 1;
const onePlace = [
  (value: { parentId?: string; space?: string; teamspaceId?: string }) =>
    exactlyOne(value.parentId, value.space, value.teamspaceId),
  { message: "give one of parentId, space or teamspaceId" },
] as const;

/** `GET /nodes?space=&teamspace=&parent=`: a folder's contents, folders first, then by name. */
export const storageListQuerySchema = z
  .object({
    space: storageSpaceSchema.optional(),
    teamspace: id.optional(),
    parent: id.optional(),
    ...page,
  })
  .refine((query) => exactlyOne(query.parent, query.space, query.teamspace), {
    message: "give one of parent, space or teamspace",
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

/**
 * `GET /search?q=`: what a name holds, ignoring case. `drive=team` leaves out My files; `type`
 * keeps only files of that type, and folders, to browse into. Both apply before the limit.
 */
export const storageSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(255),
  drive: z.literal("team").optional(),
  type: z.string().trim().min(1).max(255).optional(),
});
/**
 * Drive's `GET /search`, folders first, then by name: live nodes across the member's My files
 * and, in a company, Shared. Not paged.
 */
export const storageFindResponseSchema = z.object({ nodes: z.array(storageNodeSchema) });

/**
 * Drive's `GET /icons?space=` or `?teamspace=`: the chosen glyphs of a drive's top-level folders,
 * by folder id. A folder without one is absent. Strings, not the enum, so an older client still
 * reads a new glyph.
 */
export const storageFolderIconsQuerySchema = z
  .object({ space: storageSpaceSchema.optional(), teamspace: id.optional() })
  .refine((query) => exactlyOne(query.space, query.teamspace), {
    message: "give either space or teamspace",
  });
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
 * dropped connection, `GET /uploads/:id` and send the rest. A part may be sent again. An upload
 * closes a day after its last part (`expiresAt`), and at most six days after it opened.
 */
export const storageUploadSchema = z.object({
  id,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  space: storageNodeSpaceSchema,
  /** The teamspace whose root it lands in, when it has no `parentId`. */
  teamspaceId: id.nullable().optional(),
  parentId: id.nullable(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().nonnegative(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), size: z.number().int() })),
  expiresAt: isoDate,
  /** The file it became, once completed. */
  nodeId: id.nullable(),
});
export const storageUploadResponseSchema = z.object({ upload: storageUploadSchema });

/**
 * `PUT /uploads/:id/parts/:n`: the part stored, and when the upload now closes. Each part moves
 * that forward a day, so an upload only expires after a day with no parts.
 */
export const storageUploadPartResponseSchema = z.object({
  part: z.object({ partNumber: z.number().int().positive(), size: z.number().int() }),
  expiresAt: isoDate,
});

/**
 * `PATCH /uploads/:id`: points an upload in progress somewhere else (and optionally renames it)
 * without sending its parts again, as after completing answered `parent_trashed`. Not for a new
 * version of a file.
 */
export const storageMoveUploadBodySchema = z
  .object({ name: name.optional(), ...place })
  .refine(...onePlace);

/** `POST /uploads/:id/complete?ifContentVersion=`: a checked save's base, checked again. */
export const storageCompleteUploadQuerySchema = z.object({
  ifContentVersion: z.coerce.number().int().nonnegative().optional(),
});

/**
 * `POST /files/:id/versions`: an upload of new bytes for an existing file. On complete the node
 * keeps its id, name and sharing, and its `contentVersion` goes up. `ifContentVersion` is the
 * version the client read: a newer one answers `409 version_conflict` (with the server's
 * `contentVersion` in `details`) and stores nothing. Send it again on complete, which checks it
 * once more.
 */
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
  writtenByAgent: z.string().nullable().optional(),
  writtenByGuest: z.boolean().optional(),
  coauthors: z
    .array(z.object({ kind: z.enum(["guest", "grantee"]), id, name: z.string() }))
    .optional(),
});
export const storageVersionSchema = storageContentSchema.extend({ id, replacedAt: isoDate });

/**
 * `GET /files/:id/versions`: the file's current content and the versions it replaced, newest
 * first: one for each editing session (a member's autosaves minutes apart are one session; an
 * agent's edit is always its own). `GET /files/:id/versions/:versionId/content` downloads one, and
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
  /** Null until the node is first shared. The link is `/s/<shareId>` in every mode. */
  shareId: z.string().nullable(),
  linkAccess: storageLinkAccessSchema,
  /** Absent from a Worker older than link settings. */
  link: storageLinkSchema.optional(),
  /** The workspace's policy, so a client offers only what it allows. Absent as above. */
  policy: storagePolicySchema.optional(),
  people: z.array(storagePersonSchema),
  /** People who reach the node through a folder above it. */
  inherited: z.array(storagePersonSchema.extend({ nodeId: id, nodeName: z.string() })),
});
export const storageSharingResponseSchema = z.object({ sharing: storageSharingSchema });

/**
 * `PUT /nodes/:id/sharing/link`: set who it opens for, `reset` for a new link (the old one stops
 * working, settings stay), or change its settings: `expiresAt` (null: never), `password` (null
 * removes it), `downloads` and `role`. `403 sharing_policy` when the workspace's policy refuses it.
 *
 * `GET /uploads/:id/sharing` and `PUT /uploads/:id/sharing/link` do the same for a new file
 * before it finishes uploading, for its uploader: `/s/<shareId>` opens from the start and shows
 * the upload's progress until the file is there. `nodeId` is the upload's id, which the file
 * keeps; completing moves the link onto the file. People are added once it is a file. After it
 * completes both answer as the file's own routes do.
 */
export const storageSetLinkBodySchema = z.union([
  z.strictObject({ linkAccess: storageLinkAccessSchema }),
  z.strictObject({ reset: z.literal(true) }),
  z
    .strictObject({
      expiresAt: isoDate.nullable().optional(),
      password: storageLinkPasswordSchema.nullable().optional(),
      downloads: z.boolean().optional(),
      /** Commenter and Editor are for docs; `403 sharing_policy` for Editor when not allowed. */
      role: storageGrantRoleSchema.optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: "change at least one setting" }),
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
 * opens: for a member of its space, a person it was shared with, and through the link itself while
 * the link is open for the visitor (anyone, or the workspace's members), has not expired and the
 * workspace's policy allows it. A link with a password answers `401 link_locked` until unlocked.
 * Anything else is `404`. `item.role` says what the reader may do. Through the link alone the
 * node carries no workspace or member ids and no hash: `orgId` is empty, the others null.
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
  /**
   * False when the link alone opened it and it is view only: `/content` answers `403`. Absent
   * from a Worker older than link settings.
   */
  downloads: z.boolean().optional(),
  /**
   * Files still uploading: the item itself, when the link was made for a file before it finished
   * (then `item` is that file as it will be, and `/content` answers `404` until it completes), or
   * those uploading into the folder, on its first page. Absent from a Worker older than this.
   */
  uploading: z.array(storageSharedUploadSchema).optional(),
  /**
   * The item is a doc this reader joins live, through `GET /shared/:shareId/realtime?node=`:
   * they edit or comment on it (not as a member), it is not locked, and the live layer is on.
   * Absent from a Worker older than live sharing.
   */
  live: z.boolean().optional(),
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
 * `?signer=` on `POST /signing/:id/code` and `/sign`: the address the page shows. When the
 * browser now opens the request as someone else, the call answers `409 signer_changed`.
 */
export const storageSignerQuerySchema = z.object({ signer: z.string().max(320).optional() });

/** `POST /api/storage/signing/:id/link`: the token from the signing mail's link. */
export const storageSigningLinkBodySchema = z.object({ token: z.string().min(20).max(200) });

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
 * `PATCH /nodes/:id?ifRevision=` and `DELETE /nodes/:id?ifRevision=`: refuse with `409
 * version_conflict` when the node's revision is no longer this one. Without it, unguarded.
 */
export const storageRevisionGuardQuerySchema = z.object({
  ifRevision: z.coerce.number().int().nonnegative().optional(),
});

/**
 * On the workspace's realtime socket (`GET /sync/:orgId/realtime` for a provider): something in
 * this drive changed, so read its changes. Sent after the change commits; it names no file.
 * `parentIds` are the folders whose listing changed, `null` for the drive's top; a folder listed
 * there may also have been renamed or moved, so a listing under it is stale too. Without it (an
 * older Worker), any listing in the drive may have changed.
 */
export const storageChangedEventSchema = z.object({
  type: z.literal("storage.changed"),
  /** `teamspace` goes to the web app only, never to a sync provider. */
  space: storageNodeSpaceSchema,
  /** The teamspace that changed, when `space` is `teamspace`. */
  teamspaceId: id.optional(),
  parentIds: z.array(id.nullable()).optional(),
});

/**
 * On the workspace's realtime socket for the web app: a teamspace was made, renamed, opened or
 * closed, given an icon or deleted, or someone joined or left one. Read `GET /teamspaces` again.
 */
export const storageTeamspacesChangedEventSchema = z.object({
  type: z.literal("storage.teamspaces"),
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
 * On the workspace's realtime socket for the web app: someone who sees the
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

/** Longest edge of a thumbnail, in pixels: the only sizes drawn, so each is drawn once. */
export const STORAGE_THUMBNAIL_SIZES = [256, 640, 1280] as const;
/** The largest original a thumbnail is drawn from; a larger one answers `415 no_thumbnail`. */
export const STORAGE_THUMBNAIL_MAX_SOURCE_BYTES = 20_000_000;
/** The most entries (files and folders) one zip carries; more answers `413 zip_too_large`. */
export const STORAGE_ZIP_MAX_ENTRIES = 5_000;

/**
 * `GET /files/:id/thumbnail?size=&v=`: a WebP no wider or taller than `size` (default 640), for
 * a JPEG, PNG, GIF, WebP, AVIF or HEIC up to 20 MB. Anything else is `415 no_thumbnail`. With
 * `v` equal to the file's `contentVersion` the answer is cacheable for a year (a new version has
 * a new `v`); without it, the client revalidates with `If-None-Match`. Also under
 * `/shared/:shareId/files/:id/thumbnail`.
 */
export const storageThumbnailQuerySchema = z.object({
  size: z.coerce
    .number()
    .refine((size) => (STORAGE_THUMBNAIL_SIZES as readonly number[]).includes(size), {
      message: `size is one of ${STORAGE_THUMBNAIL_SIZES.join(", ")}`,
    })
    .default(640),
  v: z.coerce.number().int().nonnegative().optional(),
});

/**
 * `GET /zip?ids=a,b` or `POST /zip` with a form or JSON body `{ ids }`: the selected files and
 * folders (with everything live inside them) as one streamed zip, an attachment with a known
 * `content-length`. Paths start at each selected item's own name. Under
 * `/shared/:shareId/zip` the ids default to the shared node itself. Something the caller cannot
 * reach is `404`; more than `STORAGE_ZIP_MAX_ENTRIES` entries is `413 zip_too_large`.
 */
export const storageZipQuerySchema = z.object({
  ids: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : [value])
        .flatMap((part) => part.split(","))
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(id).max(STORAGE_ZIP_MAX_ENTRIES)),
});

export type StorageSpace = z.infer<typeof storageSpaceSchema>;
export type StorageNodeSpace = z.infer<typeof storageNodeSpaceSchema>;
export type StorageChangedEvent = z.infer<typeof storageChangedEventSchema>;
export type StorageTeamspacesChangedEvent = z.infer<typeof storageTeamspacesChangedEventSchema>;
export type StorageFilePresenceEvent = z.infer<typeof storageFilePresenceEventSchema>;
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
export type StorageUploadPartResponse = z.infer<typeof storageUploadPartResponseSchema>;
export type StorageMoveUploadBody = z.infer<typeof storageMoveUploadBodySchema>;
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
export type DesktopSyncState = z.infer<typeof desktopSyncStateSchema>;
export type DesktopWorkspaceSync = z.infer<typeof desktopWorkspaceSyncSchema>;
export type DesktopSyncStatus = z.infer<typeof desktopSyncStatusSchema>;

export * from "./storage-comments.ts";
export * from "./storage-links.ts";

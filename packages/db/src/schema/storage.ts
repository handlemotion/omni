import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { members, organizations } from "./auth.ts";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `personal` is a member's My files; `shared` is the company's one shared drive. */
export const storageSpace = pgEnum("storage_space", ["personal", "shared"]);
/** In this order: a folder lists before a file. */
export const storageNodeKind = pgEnum("storage_node_kind", ["folder", "file"]);
/**
 * Who a node's link opens for: nobody beyond its grants (`restricted`), any signed-in member of
 * its workspace (`workspace`), or anyone holding it.
 */
export const storageLinkAccess = pgEnum("storage_link_access", [
  "restricted",
  "anyone",
  "workspace",
]);
/**
 * In this order: `max()` over a person's grants is the strongest one. A `commenter` reads and
 * writes comments.
 */
export const storageGrantRole = pgEnum("storage_grant_role", ["viewer", "commenter", "editor"]);

/** One part of a multipart upload, as the bucket acknowledged it. */
export interface StorageUploadPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * A file or folder. There is no drives table: a drive is `(org_id, space, owner_member_id)`,
 * and a node whose `parent_id` is null sits at its root.
 */
export const storageNodes = pgTable(
  "storage_nodes",
  {
    id: id(),
    orgId: orgId(),
    space: storageSpace("space").notNull(),
    /**
     * Whose My files this is in; null in Shared. No cascade: removing a member must move their
     * files first, and a delete that skipped that fails instead of losing
     * them. Deleting the workspace still cascades through `org_id`.
     */
    ownerMemberId: text("owner_member_id").references(() => members.id),
    parentId: text("parent_id"),
    kind: storageNodeKind("kind").notNull(),
    name: text("name").notNull(),
    /** Bytes; 0 for a folder. */
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    /** `orgs/<orgId>/<id>` for a file. The name is not in it, so rename and move never touch R2. */
    r2Key: text("r2_key"),
    /** 22 base64url characters from a CSPRNG, made the first time the node is shared. */
    shareId: text("share_id"),
    linkAccess: storageLinkAccess("link_access").notNull().default("restricted"),
    /** After this the link opens for nobody; grants and members are not affected. */
    linkExpiresAt: timestamptz("link_expires_at"),
    /** `@omni/crypto` password hash; a visitor through the link must unlock it first. */
    linkPasswordHash: text("link_password_hash"),
    /** False: a visitor through the link sees the item and cannot download it (view only). */
    linkDownloads: boolean("link_downloads").notNull().default(true),
    /** The uploader. May be a member of another workspace when an editor grant made the node. */
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Set on the node that was moved to Trash; everything inside it is in Trash with it. */
    trashedAt: timestamptz("trashed_at"),
    /**
     * The workspace's sync revision at the last change to the row, from
     * `storage_sync_state` in the same transaction. 0 for a row last changed before sync existed.
     */
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    /** Goes up each time a file's bytes are replaced in place; constant for a folder. */
    contentVersion: integer("content_version").notNull().default(1),
    /** Hex SHA-256 of the bytes, as the client that uploaded them sent it; null when unknown. */
    contentSha256: text("content_sha256"),
    /**
     * Only the workspace's own members see it and what is inside it. A grant or a link on a folder
     * above does not reach in; one on the node itself, or on something inside it, still does.
     */
    teamOnly: boolean("team_only").notNull().default(false),
    /**
     * An image that belongs to the doc it sits under (`parentId` is the doc): it follows the doc's
     * sharing and Trash, and no folder listing, search, sync or archive shows it on its own.
     */
    attached: boolean("attached").notNull().default(false),
  },
  (t) => [
    unique("storage_nodes_id_org_id_unique").on(t.id, t.orgId),
    foreignKey({
      name: "storage_nodes_parent_org_fk",
      columns: [t.parentId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }).onDelete("cascade"),
    check(
      "storage_nodes_space_owner",
      sql`(${t.space} = 'personal') = (${t.ownerMemberId} is not null)`,
    ),
    check("storage_nodes_file_key", sql`(${t.kind} = 'file') = (${t.r2Key} is not null)`),
    uniqueIndex("storage_nodes_sibling_name_key")
      .on(
        t.orgId,
        t.space,
        sql`coalesce(${t.ownerMemberId}, '')`,
        sql`coalesce(${t.parentId}, '')`,
        sql`lower(${t.name})`,
      )
      .where(sql`${t.trashedAt} is null`),
    index("storage_nodes_list_idx").on(
      t.orgId,
      t.space,
      sql`coalesce(${t.ownerMemberId}, '')`,
      sql`coalesce(${t.parentId}, '')`,
      t.kind,
      sql`lower(${t.name})`,
      t.id,
    ),
    index("storage_nodes_parent_id_idx").on(t.parentId),
    index("storage_nodes_owner_member_id_idx").on(t.ownerMemberId),
    unique("storage_nodes_share_id_unique").on(t.shareId),
    index("storage_nodes_trash_idx")
      .on(t.orgId, t.trashedAt)
      .where(sql`${t.trashedAt} is not null`),
    index("storage_nodes_sync_idx").on(
      t.orgId,
      t.space,
      sql`coalesce(${t.ownerMemberId}, '')`,
      t.revision,
      t.id,
    ),
  ],
);

/**
 * A workspace's sync counter. Every change to a node takes the next revision from
 * here in its own transaction; the row stays locked until it commits, so revisions commit in
 * order and a change feed read up to one never skips an earlier one.
 */
export const storageSyncState = pgTable("storage_sync_state", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** The last revision handed out. */
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  /**
   * Tombstones below this revision have been swept: a cursor below it may have missed a
   * deletion, so the feed answers `cursor_expired` and the client lists the drive again.
   */
  cursorFloor: bigint("cursor_floor", { mode: "number" }).notNull().default(0),
});

/**
 * A node that left a drive for good: deleted forever, purged from Trash, or moved to another
 * drive (the other space, or another member's My files in a hand-over). The change feed reports
 * it as a deletion. Swept after `STORAGE_TOMBSTONE_DAYS`.
 */
export const storageTombstones = pgTable(
  "storage_tombstones",
  {
    id: id(),
    orgId: orgId(),
    /** No foreign key: the node may be gone. */
    nodeId: text("node_id").notNull(),
    /** The drive it left. */
    space: storageSpace("space").notNull(),
    ownerMemberId: text("owner_member_id").references(() => members.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("storage_tombstones_sync_idx").on(
      t.orgId,
      t.space,
      sql`coalesce(${t.ownerMemberId}, '')`,
      t.revision,
      t.nodeId,
    ),
    index("storage_tombstones_created_at_idx").on(t.createdAt),
    index("storage_tombstones_owner_member_id_idx").on(t.ownerMemberId),
  ],
);

/**
 * Content a file used to have: one row per replaced content, kept 30 days
 * from `replaced_at`. The file's current content stays on its node. A version owns its object as
 * a node does, so whatever deletes a file deletes its versions' objects with it.
 */
export const storageVersions = pgTable(
  "storage_versions",
  {
    id: id(),
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mimeType: text("mime_type"),
    r2Key: text("r2_key").notNull(),
    /** Who wrote this content; null once that member is gone. */
    writtenByMemberId: text("written_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    writtenAt: timestamptz("written_at").notNull(),
    replacedAt: timestamptz("replaced_at").notNull().defaultNow(),
    /**
     * The file's `content_version` while this was its content, so a comment or signature made on
     * it can find it. Null for a version kept before this column existed.
     */
    contentVersion: integer("content_version"),
    /** The agent that wrote it for `written_by_member_id`; null when they wrote it in the app. */
    writtenByAgent: text("written_by_agent"),
    /**
     * Set when a later save in the same editing session replaced it: an autosave between the
     * session's first and last, hidden from the file's versions and purged a day later.
     */
    supersededAt: timestamptz("superseded_at"),
  },
  (t) => [
    foreignKey({
      name: "storage_versions_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    index("storage_versions_node_id_idx").on(t.nodeId, t.replacedAt.desc().nullsFirst(), t.id),
    index("storage_versions_replaced_at_idx").on(t.replacedAt),
    index("storage_versions_org_id_idx").on(t.orgId),
    index("storage_versions_written_by_member_id_idx").on(t.writtenByMemberId),
    index("storage_versions_superseded_at_idx")
      .on(t.supersededAt)
      .where(sql`${t.supersededAt} is not null`),
  ],
);

/**
 * Who wrote a file's current content, and when, once it has replaced an earlier one.
 * No row: the content is the one the file was created with. A table of its own, as
 * `storage_upload_targets` is, so that the code reading `storage_nodes` and `storage_uploads`
 * before these existed keeps working beside them.
 */
export const storageContents = pgTable(
  "storage_contents",
  {
    nodeId: text("node_id").primaryKey(),
    orgId: orgId(),
    writtenByMemberId: text("written_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    writtenAt: timestamptz("written_at").notNull(),
    /** The agent that wrote it for `written_by_member_id`; null when they wrote it in the app. */
    writtenByAgent: text("written_by_agent"),
    /**
     * Set when an agent changes the file's live document: the next save, whoever makes it, keeps
     * this content as a version instead of continuing the editing session that wrote it.
     */
    sessionEnded: boolean("session_ended").notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: "storage_contents_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    index("storage_contents_written_by_member_id_idx").on(t.writtenByMemberId),
  ],
);

/**
 * A locked file: it cannot be renamed, moved, trashed or deleted for good,
 * and a folder holding one cannot be trashed or leave its drive. A row is the lock; only a file
 * is locked, which `storage/lock.ts` checks. Only an owner or admin unlocks. Deleting the node,
 * or the workspace, takes the lock with it.
 */
export const storageLocks = pgTable(
  "storage_locks",
  {
    nodeId: text("node_id").primaryKey(),
    orgId: orgId(),
    lockedAt: timestamptz("locked_at").notNull().defaultNow(),
    /** Who locked it; null once that member is gone, and the file stays locked. */
    lockedByMemberId: text("locked_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    foreignKey({
      name: "storage_locks_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
  ],
);

/**
 * A cluster's chosen glyph in Drive's sidebar (`STORAGE_FOLDER_ICONS`); no row is the
 * folder glyph. Its own table, not a column on `storage_nodes`, so no query that reads or writes
 * nodes depends on it. Deleting the node takes the glyph with it.
 */
export const storageFolderIcons = pgTable(
  "storage_folder_icons",
  {
    nodeId: text("node_id").primaryKey(),
    orgId: orgId(),
    icon: text("icon").notNull(),
  },
  (t) => [
    foreignKey({
      name: "storage_folder_icons_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
  ],
);

/**
 * A person a node is shared with. The grantee is an address, not a user, so a grant can exist
 * before the person does. A grant on a folder covers everything inside it.
 */
export const storageGrants = pgTable(
  "storage_grants",
  {
    id: id(),
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    /** Lowercase. */
    email: text("email").notNull(),
    role: storageGrantRole("role").notNull(),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "storage_grants_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    unique("storage_grants_node_id_email_unique").on(t.nodeId, t.email),
    index("storage_grants_email_idx").on(t.email),
  ],
);

/**
 * A workspace's sharing policy, set by its owners and admins. No row: everything is allowed.
 * `public_links` false closes every link open to anyone and refuses new ones; `outside_sharing`
 * false refuses new grants to an address outside the company.
 */
export const storagePolicies = pgTable("storage_policies", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  publicLinks: boolean("public_links").notNull().default(true),
  outsideSharing: boolean("outside_sharing").notNull().default(true),
  updatedByMemberId: text("updated_by_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const storageShareEventKind = pgEnum("storage_share_event_kind", [
  "link_changed",
  "grant_added",
  "grant_changed",
  "grant_removed",
  "viewed",
  "downloaded",
]);

/**
 * The sharing audit trail: who changed a node's sharing, and every view and download through
 * `/shared/:shareId`. Append only: nothing updates or deletes a row but the workspace's own
 * deletion. `node_id` has no foreign key so a node deleted for good keeps its history.
 */
export const storageShareEvents = pgTable(
  "storage_share_events",
  {
    id: id(),
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    kind: storageShareEventKind("kind").notNull(),
    /** The door that opened it: `member`, `grant` or `link`. */
    via: text("via").notNull(),
    /** Null for an anonymous visitor, and for a member of another workspace. */
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    /** The signed-in user; null for an anonymous visitor. */
    actorUserId: text("actor_user_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("storage_share_events_node_idx").on(t.orgId, t.nodeId, t.createdAt)],
);

/**
 * An upload in progress. Its id becomes the file's id, so the object key is known from the
 * start. `node_id` is set when it completes, which makes completing twice return the same file.
 */
export const storageUploads = pgTable(
  "storage_uploads",
  {
    id: id(),
    orgId: orgId(),
    /** Who opened it. May be a member of another workspace when an editor grant allowed it. */
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    space: storageSpace("space").notNull(),
    /** The folder it lands in; null is the root of the member's My files or of Shared. */
    parentId: text("parent_id"),
    name: text("name").notNull(),
    /** Declared bytes: counted against the quota from the moment the upload opens. */
    size: bigint("size", { mode: "number" }).notNull(),
    mimeType: text("mime_type"),
    r2Key: text("r2_key").notNull(),
    /** The bucket's multipart upload id; null until the bucket has opened it. */
    r2UploadId: text("r2_upload_id"),
    /**
     * Parts recorded before `storage_upload_parts` existed. Read beside that table until no
     * upload opened by an older Worker is still open; nothing writes here any more.
     */
    parts: jsonb("parts").$type<StorageUploadPart[]>().notNull().default([]),
    nodeId: text("node_id"),
    /** Hex SHA-256 the client computed while reading the file; null when it sent none. */
    sha256: text("sha256"),
    /** When the Worker hashed the stitched object and it matched `sha256`. */
    sha256CheckedAt: timestamptz("sha256_checked_at"),
    /** The agent writing it for its member (an MCP client's name); null from the app. */
    agent: text("agent"),
    /** Moves forward with every part recorded: only a day with no parts closes an upload. */
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "storage_uploads_parent_org_fk",
      columns: [t.parentId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "storage_uploads_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    index("storage_uploads_org_id_idx").on(t.orgId),
    index("storage_uploads_expires_at_idx").on(t.expiresAt),
    index("storage_uploads_member_id_idx").on(t.memberId),
  ],
);

/**
 * One part of an upload, as the bucket acknowledged it: a row each, so recording a part writes
 * one row however many came before. Sending a part again replaces its row.
 */
export const storageUploadParts = pgTable(
  "storage_upload_parts",
  {
    uploadId: text("upload_id")
      .notNull()
      .references(() => storageUploads.id, { onDelete: "cascade" }),
    orgId: orgId(),
    partNumber: integer("part_number").notNull(),
    etag: text("etag").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.partNumber] })],
);

/**
 * The file an upload is a new version of. An upload with no row here
 * becomes a new file. Completing one with a row replaces that file's content and sets the
 * upload's `node_id` to it. Goes with the upload. When the file is deleted first, the row stays
 * with `node_id` null: the upload was a replacement whose target is gone, and must never
 * complete as a file of its own.
 */
export const storageUploadTargets = pgTable(
  "storage_upload_targets",
  {
    uploadId: text("upload_id")
      .primaryKey()
      .references(() => storageUploads.id, { onDelete: "cascade" }),
    orgId: orgId(),
    nodeId: text("node_id").references(() => storageNodes.id, { onDelete: "set null" }),
  },
  (t) => [index("storage_upload_targets_node_id_idx").on(t.nodeId)],
);

/**
 * A link made for a file while it still uploads. Its `share_id` opens `/s/<shareId>` from the
 * start: a processing page with the upload's progress, under the same rules as a node's link
 * (who it opens for, expiry, password, downloads, the workspace's policy). Completing the upload
 * moves the link onto the new file, whose id is the upload's, so the address never changes. Goes
 * with the upload when it is cancelled or expires.
 */
export const storageUploadLinks = pgTable(
  "storage_upload_links",
  {
    uploadId: text("upload_id")
      .primaryKey()
      .references(() => storageUploads.id, { onDelete: "cascade" }),
    orgId: orgId(),
    shareId: text("share_id").notNull(),
    linkAccess: storageLinkAccess("link_access").notNull().default("restricted"),
    linkExpiresAt: timestamptz("link_expires_at"),
    linkPasswordHash: text("link_password_hash"),
    linkDownloads: boolean("link_downloads").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [unique("storage_upload_links_share_id_unique").on(t.shareId)],
);

/**
 * Bytes a workspace stores, trashed files included. One row per workspace, changed in the same
 * transaction as the node it counts and recomputed from `storage_nodes` daily.
 */
export const storageUsage = pgTable("storage_usage", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
});

/** The most a workspace stored in a usage month: what is billed. */
export const storagePeaks = pgTable(
  "storage_peaks",
  {
    orgId: orgId(),
    /** Start of the usage month, as for `triage_usage`. */
    periodStart: timestamptz("period_start").notNull(),
    peakBytes: bigint("peak_bytes", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.periodStart] })],
);

/**
 * Workspaces whose subscription Stripe showed with a payment method: the one fact "no overage
 * without a card" needs that the subscription row lacks. Written from
 * Stripe's webhook and by the daily job; a row counts only for the subscription it names.
 */
export const storageOverage = pgTable("storage_overage", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  checkedAt: timestamptz("checked_at").notNull().defaultNow(),
});

export * from "./storage/comments.ts";
export * from "./storage/signing.ts";
export * from "./storage/texts.ts";

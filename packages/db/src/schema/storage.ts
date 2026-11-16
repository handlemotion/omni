// Storage (ADR 0034): a folder tree per workspace, with a private side (My files, per member)
// and, in a company, a shared side. These rows are the truth, not an index: a lost node loses
// the file even though its bytes are still in the bucket. Access is decided only in
// `src/storage.ts`.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
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
export const storageLinkAccess = pgEnum("storage_link_access", ["restricted", "anyone"]);
/** In this order: `max()` over a person's grants is the strongest one. */
export const storageGrantRole = pgEnum("storage_grant_role", ["viewer", "editor"]);

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
     * files first (ADR 0034 decision 1), and a delete that skipped that fails instead of losing
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
  },
  (t) => [
    // Target for composite foreign keys that pin a row to its node's org.
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
    // Among live siblings a name is unique, whatever its case. `coalesce` because a root has no
    // parent and Shared has no owner, and nulls would never collide.
    uniqueIndex("storage_nodes_sibling_name_key")
      .on(
        t.orgId,
        t.space,
        sql`coalesce(${t.ownerMemberId}, '')`,
        sql`coalesce(${t.parentId}, '')`,
        sql`lower(${t.name})`,
      )
      .where(sql`${t.trashedAt} is null`),
    // A folder's page: folders first, then by name, ties by id.
    index("storage_nodes_list_idx").on(
      t.orgId,
      t.space,
      sql`coalesce(${t.ownerMemberId}, '')`,
      sql`coalesce(${t.parentId}, '')`,
      t.kind,
      sql`lower(${t.name})`,
      t.id,
    ),
    // The walk down a subtree (move, delete, purge) and the parent foreign key's cascade.
    index("storage_nodes_parent_id_idx").on(t.parentId),
    // The member foreign key's check, and the move of a removed member's files.
    index("storage_nodes_owner_member_id_idx").on(t.ownerMemberId),
    unique("storage_nodes_share_id_unique").on(t.shareId),
    index("storage_nodes_trash_idx")
      .on(t.orgId, t.trashedAt)
      .where(sql`${t.trashedAt} is not null`),
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
    // "Shared with me": every grant to one of a person's addresses.
    index("storage_grants_email_idx").on(t.email),
  ],
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
    parts: jsonb("parts").$type<StorageUploadPart[]>().notNull().default([]),
    nodeId: text("node_id"),
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
    // The quota's sum of uploads in progress.
    index("storage_uploads_org_id_idx").on(t.orgId),
    // The sweep of uploads nobody completed.
    index("storage_uploads_expires_at_idx").on(t.expiresAt),
    index("storage_uploads_member_id_idx").on(t.memberId),
  ],
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

/** The most a workspace stored in a usage month: what is billed (ADR 0034 decision 7). */
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
 * without a card" needs that the subscription row lacks (ADR 0034 decision 7). Written from
 * Stripe's webhook and by the daily job; a row counts only for the subscription it names.
 */
export const storageOverage = pgTable("storage_overage", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  checkedAt: timestamptz("checked_at").notNull().defaultNow(),
});

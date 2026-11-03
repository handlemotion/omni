import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { members, organizations, teams } from "./auth.ts";

// Text ids holding a UUIDv7: time-ordered (index friendly) and generated in the app, so a row's
// id is known before the insert and can double as an idempotency handle.
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

const memberId = () =>
  text("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" });

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export interface Address {
  name: string | null;
  address: string;
}

export const mailboxKind = pgEnum("mailbox_kind", ["personal", "shared"]);
// `imap` is any standards-based host with no provider API; `purelymail` adds its optional admin API.
export const mailProvider = pgEnum("mail_provider", ["purelymail", "gmail", "microsoft", "imap"]);
export const mailboxStatus = pgEnum("mailbox_status", ["pending", "active", "error", "disabled"]);
export const folderRole = pgEnum("folder_role", ["inbox", "sent", "archive", "trash", "other"]);
export const mailboxAccessRole = pgEnum("mailbox_access_role", ["owner", "member"]);
export const triageBucket = pgEnum("triage_bucket", [
  "needs_reply",
  "waiting_on_them",
  "fyi",
  "noise",
]);
export const triageSource = pgEnum("triage_source", ["ai", "person"]);
export const mailActionKind = pgEnum("mail_action_kind", [
  "send",
  "archive",
  "move",
  "mark_read",
  "mark_unread",
]);
export const mailActionStatus = pgEnum("mail_action_status", [
  "pending",
  "running",
  "done",
  "failed",
]);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    orgId: orgId(),
    address: text("address").notNull(),
    kind: mailboxKind("kind").notNull(),
    provider: mailProvider("provider").notNull().default("purelymail"),
    /** AES-256-GCM ciphertext. Only the mail service holds the key. */
    credentialsEnc: text("credentials_enc").notNull(),
    status: mailboxStatus("status").notNull().default("pending"),
    /**
     * A shared mailbox's Better Auth team: its members are who can see it, and `mailbox_access`
     * is derived from them (ADR 0008). Null for personal mailboxes, and for a shared mailbox
     * until `ensureMailboxTeam` runs. Same org as the mailbox, enforced where it is read.
     */
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mailboxes_org_id_address_unique").on(t.orgId, t.address),
    unique("mailboxes_team_id_unique").on(t.teamId),
    // Target for composite foreign keys that pin a child row to its mailbox's org.
    unique("mailboxes_id_org_id_unique").on(t.id, t.orgId),
  ],
);

/** A DNS record the provider asks for, with its last check. */
export interface MailDomainRecord {
  check: "ownership" | "mx" | "spf" | "dkim" | "dmarc";
  type: "TXT" | "MX" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  verified: boolean;
}

/**
 * A domain an org set up mailboxes on (ADR 0007). Unique across orgs: the first org to claim a
 * domain owns it, so no other org can create mailboxes on it through the provider API.
 */
export const mailDomains = pgTable(
  "mail_domains",
  {
    id: id(),
    orgId: orgId(),
    /** Normalized: lowercase punycode, no trailing dot. */
    domain: text("domain").notNull(),
    provider: mailProvider("provider").notNull(),
    /** Empty for `imap`: DNS belongs to the existing mail host. */
    dnsRecords: jsonb("dns_records").$type<MailDomainRecord[]>().notNull().default([]),
    /** When the provider accepted the domain (ownership proven). Set at claim for `imap`. */
    addedAt: timestamptz("added_at"),
    /** When every record last passed; null while any is waiting. */
    verifiedAt: timestamptz("verified_at"),
    checkedAt: timestamptz("checked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mail_domains_domain_unique").on(t.domain),
    index("mail_domains_org_id_idx").on(t.orgId),
  ],
);

/**
 * How far an organization's setup got, in order. Postgres compares enum values by this order,
 * so `greatest()` keeps whichever step is further along.
 */
export const setupStep = pgEnum("setup_step", [
  "created",
  "domain_added",
  "dns_verified",
  "mailboxes_created",
  "invites_sent",
  "complete",
]);

/**
 * Onboarding progress per organization (resumable setup). One row per org, written the first
 * time a setup step succeeds; it only ever moves forward. An org with no row (made by the
 * `org:create` CLI, or before this table) counts as `complete` once it has a mailbox and as
 * `created` before that (`orgSetupStep`).
 */
export const orgSetup = pgTable("org_setup", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  step: setupStep("step").notNull().default("created"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const mailboxFolders = pgTable(
  "mailbox_folders",
  {
    id: id(),
    orgId: orgId(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    role: folderRole("role").notNull().default("other"),
    uidvalidity: bigint("uidvalidity", { mode: "number" }),
    uidnext: bigint("uidnext", { mode: "number" }),
    // MODSEQ is a 63-bit counter; keep it exact.
    highestModseq: bigint("highest_modseq", { mode: "bigint" }),
    syncedAt: timestamptz("synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("mailbox_folders_mailbox_id_path_unique").on(t.mailboxId, t.path)],
);

export const mailboxAccess = pgTable(
  "mailbox_access",
  {
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    memberId: memberId(),
    role: mailboxAccessRole("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.mailboxId, t.memberId] }),
    index("mailbox_access_member_id_idx").on(t.memberId),
    foreignKey({
      name: "mailbox_access_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    lastMessageAt: timestamptz("last_message_at").notNull(),
    archived: boolean("archived").notNull().default(false),
    triage: triageBucket("triage"),
    triageConfidence: real("triage_confidence"),
    triageSource: triageSource("triage_source"),
    /**
     * The message the triage describes: the thread's latest message when it was triaged. A job for
     * that message again skips the model, and a newer message re-triages even a person's re-sort.
     * A re-sort sets it to the latest message it was made on.
     */
    triageMessageId: text("triage_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    summary: text("summary"),
    /** Last message the summary covers; a newer message means the summary is stale. */
    summaryMessageId: text("summary_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "threads_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("threads_mailbox_list_idx").on(t.mailboxId, t.archived, t.lastMessageAt.desc()),
    index("threads_mailbox_triage_idx").on(t.mailboxId, t.triage, t.lastMessageAt.desc()),
    // Thread lists read the top of one mailbox at a time in exact keyset order (ties broken by
    // id), so each mailbox costs `limit` index entries however big it is. `nulls first` matches
    // what `order by ... desc` means; the two indexes above (Drizzle's default `desc nulls last`)
    // cannot serve that order, and can be dropped once these ship.
    index("threads_mailbox_page_idx").on(
      t.mailboxId,
      t.archived,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_lane_page_idx").on(
      t.mailboxId,
      t.archived,
      t.triage,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // Views that ignore `archived` (All mail, Done) page each mailbox in the same keyset order.
    index("threads_mailbox_all_page_idx").on(
      t.mailboxId,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // Subject threading looks up recent threads by normalized subject for every new message.
    index("threads_mailbox_subject_key_idx").on(
      t.mailboxId,
      t.subjectKey,
      t.lastMessageAt.desc().nullsFirst(),
    ),
    // Deleting a message sets this to null; without an index every deleted message scans
    // `threads`, which makes removing a mailbox quadratic.
    index("threads_summary_message_id_idx")
      .on(t.summaryMessageId)
      .where(sql`${t.summaryMessageId} is not null`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // Null until the message exists in an IMAP folder (e.g. a send before the Sent append).
    folderId: text("folder_id").references(() => mailboxFolders.id, { onDelete: "set null" }),
    imapUid: bigint("imap_uid", { mode: "number" }),
    /** Message-ID header, or a hash of the headers when the message has none. */
    messageIdHeader: text("message_id_header").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull().default(""),
    fromName: text("from_name"),
    fromAddress: text("from_address").notNull(),
    to: jsonb("to").$type<Address[]>().notNull().default([]),
    cc: jsonb("cc").$type<Address[]>().notNull().default([]),
    sentAt: timestamptz("sent_at").notNull(),
    r2Key: text("r2_key"),
    /** Sanitized HTML body in R2; the only HTML ever sent to an app. Null for text-only mail. */
    htmlR2Key: text("html_r2_key"),
    cleanText: text("clean_text").notNull().default(""),
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`setweight(to_tsvector('english', coalesce(subject, '')), 'A')
          || setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || from_address), 'B')
          || setweight(to_tsvector('english', clean_text), 'C')`,
      ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "messages_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("messages_folder_id_imap_uid_unique").on(t.folderId, t.imapUid),
    unique("messages_mailbox_id_message_id_header_unique").on(t.mailboxId, t.messageIdHeader),
    index("messages_thread_id_sent_at_idx").on(t.threadId, t.sentAt),
    index("messages_search_vector_idx").using("gin", t.searchVector),
    // Threading asks which stored messages reply to a new one, for every message that starts a
    // thread; without these an import scans the mailbox once per message.
    index("messages_mailbox_id_in_reply_to_idx").on(t.mailboxId, t.inReplyTo),
    index("messages_references_idx").using("gin", t.references),
    // Search walks each mailbox newest first when a term is common, instead of ranking every hit.
    index("messages_mailbox_id_sent_at_idx").on(
      t.mailboxId,
      t.sentAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);

/**
 * Every IMAP copy of a message: one row per (folder, UID). A message filed in two folders (a
 * note to self in INBOX and Sent) is one `messages` row with two locations, so neither folder's
 * sync sees the other's copy as missing. Flags are per copy, as on the server.
 */
export const messageLocations = pgTable(
  "message_locations",
  {
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => mailboxFolders.id, { onDelete: "cascade" }),
    imapUid: bigint("imap_uid", { mode: "number" }).notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The copy's full IMAP flag set, sorted. */
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    modseq: bigint("modseq", { mode: "bigint" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.imapUid] }),
    index("message_locations_message_id_idx").on(t.messageId),
    foreignKey({
      name: "message_locations_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    orgId: orgId(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("attachments_message_id_idx").on(t.messageId),
    // The content hash in `<org>/<mailbox>/att/<sha256>`, which the image proxy looks up by.
    index("attachments_content_hash_idx").on(sql`split_part(${t.r2Key}, '/att/', 2)`),
  ],
);

export const threadState = pgTable(
  "thread_state",
  {
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    memberId: memberId(),
    read: boolean("read").notNull().default(false),
    /** Deferred (the Queue) until this time; back in the Inbox once it passes. */
    snoozedUntil: timestamptz("snoozed_until"),
    /**
     * Done, up to the thread's `last_message_at` as the member saw it. The thread is done while
     * `last_message_at <= done_through`, so a newer message brings it back to the Inbox without
     * any job (ADR 0007).
     */
    doneThrough: timestamptz("done_through"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.memberId] })],
);

export const assignments = pgTable("assignments", {
  orgId: orgId(),
  // One assignee per thread: the first to reply or claim it.
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  memberId: memberId(),
  assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
});

export const mailActions = pgTable(
  "mail_actions",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    /** Who asked for it; null for system actions or after the member is removed. */
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    kind: mailActionKind("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: mailActionStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Earliest time a worker may claim it; pushed out on retry for backoff. */
    runAfter: timestamptz("run_after").notNull().defaultNow(),
    /** When the current claim started. A stale lease means the worker died; reclaim it. */
    lockedAt: timestamptz("locked_at"),
    /** SMTP accepted the send; a retry only finishes the Sent append and never resends. */
    smtpAcceptedAt: timestamptz("smtp_accepted_at"),
    completedAt: timestamptz("completed_at"),
    /** The request that asked for it (`x-request-id`): ties its logs to the Worker's. */
    requestId: text("request_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "mail_actions_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("mail_actions_claim_idx")
      .on(t.runAfter)
      .where(sql`${t.status} in ('pending', 'running')`),
  ],
);

/**
 * Background jobs that will not run again: Cloudflare Queue messages that reached the dead-letter
 * queue. Failed outbox actions stay in `mail_actions` (status `failed`); the dead-letter listing
 * reads both. Keyed by `job_id`, so recording one twice (the consumer's last attempt and the DLQ
 * consumer) keeps the first row, which has the error.
 */
export const deadLetters = pgTable(
  "dead_letters",
  {
    id: id(),
    orgId: orgId(),
    /** The queue the job came from, e.g. `omni-ai`. */
    queue: text("queue").notNull(),
    jobId: text("job_id").notNull().unique(),
    /** The job body: ids only, never mail content. */
    job: jsonb("job").$type<Record<string, unknown>>().notNull(),
    /** Null when the consumer died without reporting one; the logs have the job id. */
    error: text("error"),
    attempts: integer("attempts").notNull(),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [index("dead_letters_created_idx").on(t.createdAt)],
);

export const triageFeedback = pgTable(
  "triage_feedback",
  {
    id: id(),
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    memberId: memberId(),
    fromBucket: triageBucket("from_bucket"),
    toBucket: triageBucket("to_bucket").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("triage_feedback_org_id_created_at_idx").on(t.orgId, t.createdAt)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    orgId: orgId(),
    day: date("day", { mode: "string" }).notNull(),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] })],
);

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    expoToken: text("expo_token").notNull(),
    device: text("device"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("push_tokens_expo_token_unique").on(t.expoToken),
    index("push_tokens_member_id_idx").on(t.memberId),
  ],
);

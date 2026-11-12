import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
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
export const folderRole = pgEnum("folder_role", [
  "inbox",
  "sent",
  "archive",
  "trash",
  "other",
  "junk",
  "drafts",
]);
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
  "trash",
  "spam",
  "not_spam",
]);
/**
 * A shared conversation's status (ADR 0021): `open` waits on the team, `pending` on the customer,
 * `snoozed` until `snoozed_until`, `resolved` is filed. Transitions: `@omni/mail-core/conversation-status`.
 */
export const conversationStatus = pgEnum("conversation_status", [
  "open",
  "pending",
  "snoozed",
  "resolved",
]);
export const conversationPriority = pgEnum("conversation_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);
export const conversationEventKind = pgEnum("conversation_event_kind", [
  "status",
  "assigned",
  "priority",
  "tag_added",
  "tag_removed",
  "note",
  "first_response",
  "sla_at_risk",
  "sla_breached",
]);
export const notificationKind = pgEnum("notification_kind", [
  "assigned",
  "mention",
  "customer_reply",
  "sla_at_risk",
  "sla_breached",
]);
export const draftKind = pgEnum("draft_kind", ["new", "reply", "forward"]);
export const theme = pgEnum("theme", ["system", "light", "dark"]);

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
    /**
     * When a check last found Omni's challenge gone from DNS (ADR 0010). Set: sending from the
     * domain pauses; the lock stays. Cleared when the challenge verifies again.
     */
    dnsLostAt: timestamptz("dns_lost_at"),
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

/** One record's verdict at the last check (`@omni/mail-core/dns-diagnostics`). */
export interface DomainRecordDiagnostic {
  type: "TXT" | "MX" | "CNAME";
  name: string;
  status: string;
  message: string;
  found: string[];
  suggestion?: string;
}

/** What the last DNS check of a claim saw (ADR 0011), shown until the next one. */
export interface DomainCheck {
  checkedAt: string;
  zone: string | null;
  nameservers: string[];
  /** The DNS host, when its nameservers say which. */
  host: { id: string; name: string; steps: string; help: string } | null;
  /** The host's Domain Connect settings, when it offers the standard and our template. */
  domainConnect: {
    providerName: string;
    urlSyncUX: string;
    urlAPI: string;
    zone: string;
  } | null;
  challenge: DomainRecordDiagnostic | null;
  records: DomainRecordDiagnostic[];
}

export const domainClaimStatus = pgEnum("domain_claim_status", ["pending", "verified", "released"]);

/**
 * An org's claim on a domain (ADR 0010). Many orgs may hold a pending claim on one domain; the
 * first to publish its challenge in DNS locks the domain (its `mail_domains` row, with the same
 * id). Pending claims expire. One row per (org, domain): claiming again rotates the challenge.
 */
export const domainClaims = pgTable(
  "domain_claims",
  {
    id: id(),
    orgId: orgId(),
    /** Normalized like `mail_domains.domain`. */
    domain: text("domain").notNull(),
    status: domainClaimStatus("status").notNull().default("pending"),
    /** SHA-256 (hex) of the challenge TXT value. The value is shown once and never stored. */
    challengeHash: text("challenge_hash").notNull(),
    provider: mailProvider("provider").notNull(),
    /** The provider's records, so they can all be added with the challenge in one visit. */
    dnsRecords: jsonb("dns_records").$type<MailDomainRecord[]>().notNull().default([]),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** A pending claim past this is dead: it cannot verify, and it no longer counts to the cap. */
    expiresAt: timestamptz("expires_at").notNull(),
    verifiedAt: timestamptz("verified_at"),
    checkedAt: timestamptz("checked_at"),
    /** The last check's per-record verdicts and the DNS host it found. */
    lastCheck: jsonb("last_check").$type<DomainCheck>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("domain_claims_org_domain_unique").on(t.orgId, t.domain),
    index("domain_claims_domain_idx").on(t.domain),
  ],
);

/**
 * Who did what to an org's shared setup, newest last. Append-only. `action` is dotted
 * (`domain.claimed`, `domain.verified`, ...); `subject` is what it happened to (the domain).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: orgId(),
    /** Null for the system (a scheduled DNS check). */
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_org_subject_idx").on(t.orgId, t.subject, t.createdAt)],
);

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
    /**
     * Set when the latest message was not AI-triaged because the workspace used its monthly
     * allowance (ADR 0015): when the allowance resets. Cleared by the next triage.
     */
    triagePausedUntil: timestamptz("triage_paused_until"),
    // Helpdesk conversation state (ADR 0021): shared by everyone who can see the inbox. Read
    // state stays per member in `thread_state`. Personal mailboxes ignore these columns.
    status: conversationStatus("status").notNull().default("open"),
    assigneeMemberId: text("assignee_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    priority: conversationPriority("priority").notNull().default("normal"),
    /** Set while `status` is `snoozed`: when it opens again. */
    snoozedUntil: timestamptz("snoozed_until"),
    customerId: text("customer_id").references((): AnyPgColumn => customers.id, {
      onDelete: "set null",
    }),
    firstResponseDueAt: timestamptz("first_response_due_at"),
    nextResponseDueAt: timestamptz("next_response_due_at"),
    resolutionDueAt: timestamptz("resolution_due_at"),
    firstRespondedAt: timestamptz("first_responded_at"),
    resolvedAt: timestamptz("resolved_at"),
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
    // Helpdesk views page one inbox at a time in the same keyset order as the lists above:
    // Open, Pending, Snoozed, Resolved by status; Mine and Unassigned (null) by assignee.
    index("threads_mailbox_status_page_idx").on(
      t.mailboxId,
      t.status,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_assignee_page_idx").on(
      t.mailboxId,
      t.assigneeMemberId,
      t.status,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // SLA clocks run while a conversation is open. The per-inbox "SLA at risk" view and the
    // per-minute cron both read the soonest due time.
    index("threads_mailbox_sla_due_idx")
      .on(t.mailboxId, slaDueAt(t))
      .where(sql`${t.status} = 'open'`),
    index("threads_sla_due_idx")
      .on(slaDueAt(t))
      .where(sql`${t.status} = 'open'`),
    // The snooze cron wakes conversations whose time has come.
    index("threads_snoozed_until_idx")
      .on(t.snoozedUntil)
      .where(sql`${t.status} = 'snoozed'`),
    index("threads_customer_idx").on(t.customerId, t.lastMessageAt.desc().nullsFirst()),
    // Deleting a member sets this to null; index it so that is not a scan.
    index("threads_assignee_member_id_idx")
      .on(t.assigneeMemberId)
      .where(sql`${t.assigneeMemberId} is not null`),
  ],
);

/**
 * The soonest SLA due time of a conversation, null when none is set. Queries filter and order by
 * this exact expression so the `*_sla_due_idx` indexes serve them.
 */
export function slaDueAt(t: {
  firstResponseDueAt: AnyPgColumn;
  nextResponseDueAt: AnyPgColumn;
  resolutionDueAt: AnyPgColumn;
}): SQL {
  return sql`least(${t.firstResponseDueAt}, ${t.nextResponseDueAt}, ${t.resolutionDueAt})`;
}

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
    /** Remote images the sanitizer replaced; the reader offers to load them. */
    remoteImageCount: integer("remote_image_count").notNull().default(0),
    /**
     * Set when the mail service stores the row; cleared once the Worker accepts its
     * `message.created`. A sweep re-sends what is still set after a crash or Worker outage.
     * Defaults false so existing rows are never re-notified.
     */
    notifyPending: boolean("notify_pending").notNull().default(false),
    /**
     * A machine sent it (bounce, auto-reply, out of office: `@omni/mail-core` `automatedKind`).
     * The helpdesk never reopens a conversation or starts an SLA on one.
     */
    automated: boolean("automated").notNull().default(false),
    /**
     * When the Worker applied this message to its conversation (status rule, first response,
     * SLA). Claimed once, so a redelivered `message.created` cannot apply an old message again.
     */
    workflowAppliedAt: timestamptz("workflow_applied_at"),
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
    index("messages_notify_pending_idx")
      .on(t.mailboxId)
      .where(sql`${t.notifyPending}`),
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
    /** Shown inside the body (`cid:` image), not as a chip. */
    inline: boolean("inline").notNull().default(false),
    /** The part's Content-ID without angle brackets, for `cid:` references. */
    contentId: text("content_id"),
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
  (t) => [
    primaryKey({ columns: [t.threadId, t.memberId] }),
    // The Queue checks each candidate thread against the member's deferred rows. Those are a
    // sliver of `thread_state`, so probing this instead of the primary key reads a few pages and
    // answers from the index alone (perf:explain: 41k buffers down to 8k). The two trailing
    // columns are only there for that; Drizzle has no `include`.
    index("thread_state_member_deferred_idx")
      .on(t.memberId, t.threadId, t.snoozedUntil, t.doneThrough)
      .where(sql`${t.snoozedUntil} is not null`),
  ],
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

/**
 * One row per AI-triaged email per workspace per usage month (ADR 0015): the count is the rows.
 * Keyed on the message, so a retried or redelivered job never counts twice. No foreign key to
 * `messages`: an email re-synced under a new id was still triaged once.
 */
export const triageUsage = pgTable(
  "triage_usage",
  {
    orgId: orgId(),
    /** Start of the usage month the email counts toward. */
    periodStart: timestamptz("period_start").notNull(),
    messageId: text("message_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.periodStart, t.messageId] })],
);

/**
 * Stripe webhook events already applied. A replay of one is a no-op, and an event older than one
 * already applied to the same object is skipped, since Stripe does not deliver in order.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    /** Stripe's event id (`evt_...`). */
    id: text("id").primaryKey(),
    /** The workspace the event is about, when its metadata names one. */
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** The event's object (`sub_...`, `cs_...`). */
    objectId: text("object_id"),
    /** When Stripe created the event. */
    eventCreatedAt: timestamptz("event_created_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("stripe_events_object_idx").on(t.objectId, t.eventCreatedAt)],
);

/**
 * Free trials granted, and to whom: one per workspace and one per account, ever (ADR 0015). The
 * person who starts a trial uses up their own, so a new workspace of theirs pays. No foreign
 * keys: deleting the workspace or leaving it must not hand the trial back.
 */
export const trialClaims = pgTable("trial_claims", {
  /** The workspace the trial is for. */
  orgId: text("org_id").primaryKey(),
  /** The account that started it. */
  userId: text("user_id").notNull().unique(),
  createdAt: createdAt(),
});

// Helpdesk (ADR 0021). Postgres holds the workflow; IMAP stays the source of truth for mail, so
// none of these rows is derived from a mailbox sync, and a full re-sync leaves them alone.

/** One file on a draft: exactly one of the two ids. */
export interface DraftAttachment {
  /** A file uploaded for this draft (`uploads.id`). */
  uploadId?: string;
  /** An attachment of a stored message, forwarded by reference (`attachments.id`). */
  attachmentId?: string;
}

/**
 * Who did what to a conversation, oldest first. Append-only, written in the same transaction as
 * the change it records; it drives the timeline, notifications and reports.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** Null for the system (ingest, SLA cron, AI triage). */
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    kind: conversationEventKind("kind").notNull(),
    /** Before and after, by kind: `{ from, to }` for status, priority and assignee. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Set for events a job may emit twice (SLA at risk and breached: the target and due time).
     * Unique per conversation, so a second run inserts nothing.
     */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "conversation_events_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("conversation_events_thread_idx").on(t.threadId, t.createdAt),
    index("conversation_events_mailbox_report_idx").on(t.mailboxId, t.kind, t.createdAt),
    uniqueIndex("conversation_events_dedupe_unique")
      .on(t.threadId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

/** Internal notes in a conversation's timeline. Never sent and never written to IMAP. */
export const notes = pgTable(
  "notes",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    authorMemberId: text("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    /** Members @mentioned in the body (`members.id`). */
    mentions: text("mentions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "notes_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("notes_thread_idx").on(t.threadId, t.createdAt),
  ],
);

/** An inbox's tag list. Names are unique per inbox, ignoring case. */
export const tags = pgTable(
  "tags",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    name: text("name").notNull(),
    /** A token name from the design system, not a hex value. */
    color: text("color"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "tags_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    uniqueIndex("tags_mailbox_name_unique").on(t.mailboxId, sql`lower(${t.name})`),
  ],
);

export const threadTags = pgTable(
  "thread_tags",
  {
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    /** Null when AI triage or a canned reply added it. */
    addedByMemberId: text("added_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.tagId] }),
    // The "by tag" view starts from the tag.
    index("thread_tags_tag_idx").on(t.tagId, t.threadId),
  ],
);

/**
 * Reply templates with `{{customer.first_name}}`-style variables. An inbox's (`mailbox_id`) or one
 * member's own (`owner_member_id`), never both. Using one can also set status and add tags.
 */
export const cannedReplies = pgTable(
  "canned_replies",
  {
    id: id(),
    orgId: orgId(),
    mailboxId: text("mailbox_id"),
    ownerMemberId: text("owner_member_id").references(() => members.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    setStatus: conversationStatus("set_status"),
    addTagIds: text("add_tag_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "canned_replies_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    check(
      "canned_replies_one_owner",
      sql`(${t.mailboxId} is null) <> (${t.ownerMemberId} is null)`,
    ),
    index("canned_replies_mailbox_idx").on(t.mailboxId),
    index("canned_replies_owner_idx").on(t.ownerMemberId),
  ],
);

/**
 * An inbox's response targets for one priority, in minutes. A null target is not tracked. With
 * `business_hours_only`, time outside the inbox's `business_hours` does not count.
 */
export const slaPolicies = pgTable(
  "sla_policies",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    priority: conversationPriority("priority").notNull(),
    firstResponseMinutes: integer("first_response_minutes"),
    nextResponseMinutes: integer("next_response_minutes"),
    resolutionMinutes: integer("resolution_minutes"),
    businessHoursOnly: boolean("business_hours_only").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "sla_policies_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("sla_policies_mailbox_priority_unique").on(t.mailboxId, t.priority),
  ],
);

/** One weekly opening window: `day` 0 is Sunday; times are `HH:MM` in the inbox's zone. */
export interface BusinessHoursWindow {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  start: string;
  end: string;
}

/** When an inbox is staffed. One row per inbox; none means always open. */
export const businessHours = pgTable(
  "business_hours",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    /** IANA zone, e.g. `America/Mexico_City`. */
    timezone: text("timezone").notNull(),
    windows: jsonb("windows").$type<BusinessHoursWindow[]>().notNull().default([]),
    /** Closed all day, as `YYYY-MM-DD` in the inbox's zone. */
    holidays: date("holidays", { mode: "string" })
      .array()
      .notNull()
      .default(sql`'{}'::date[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "business_hours_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("business_hours_mailbox_unique").on(t.mailboxId),
  ],
);

/** The people who write to an org's inboxes, keyed by address. Filled on ingest. */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    orgId: orgId(),
    /** Normalized: lowercase. */
    address: text("address").notNull(),
    name: text("name"),
    /** The address's domain, unless it is a webmail one; the company is guessed from it. */
    domain: text("domain"),
    company: text("company"),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("customers_org_address_unique").on(t.orgId, t.address),
    index("customers_org_domain_idx").on(t.orgId, t.domain),
  ],
);

/**
 * A file a member uploaded to R2 to attach to a send. Unsent uploads are deleted after
 * `expires_at`; `used_at` marks one a send took, which the cleanup leaves alone.
 */
export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "uploads_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("uploads_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} is null`),
  ],
);

/**
 * Unsent mail, shared with everyone who can see the inbox. Postgres only: never mirrored to the
 * IMAP Drafts folder. `version` goes up on each save, so a stale autosave cannot overwrite a
 * teammate's newer one.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    /** Null for a new conversation. */
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    kind: draftKind("kind").notNull(),
    /** The message replied to or forwarded. */
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    authorMemberId: text("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    updatedByMemberId: text("updated_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    to: jsonb("to").$type<Address[]>().notNull().default([]),
    cc: jsonb("cc").$type<Address[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<Address[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    attachments: jsonb("attachments").$type<DraftAttachment[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "drafts_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("drafts_thread_idx").on(t.threadId),
    index("drafts_mailbox_idx").on(t.mailboxId, t.updatedAt.desc().nullsFirst()),
  ],
);

/** An inbox's signature (`member_id` null), or one member's own on that inbox. */
export const signatures = pgTable(
  "signatures",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "cascade" }),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "signatures_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("signatures_mailbox_member_unique").on(t.mailboxId, t.memberId).nullsNotDistinct(),
  ],
);

/** Where one notification kind reaches a member. */
export interface NotificationChannels {
  realtime: boolean;
  desktop: boolean;
  push: boolean;
}

/** A member's settings. No row means every default. */
export const memberPreferences = pgTable("member_preferences", {
  memberId: text("member_id")
    .primaryKey()
    .references(() => members.id, { onDelete: "cascade" }),
  orgId: orgId(),
  /** Per notification kind; a kind left out uses the default (all channels on). */
  notifications: jsonb("notifications")
    .$type<Partial<Record<(typeof notificationKind.enumValues)[number], NotificationChannels>>>()
    .notNull()
    .default({}),
  theme: theme("theme").notNull().default("system"),
  /** How long a send can be undone (Rodrigo, Nov 12: 5 seconds by default). 0 sends at once. */
  undoSendSeconds: integer("undo_send_seconds").notNull().default(5),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Something a member should know about: assigned to them, mentioned, their customer replied, an
 * SLA at risk. `dedupe_key` makes a job that runs twice notify once.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    kind: notificationKind("kind").notNull(),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    noteId: text("note_id").references(() => notes.id, { onDelete: "cascade" }),
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key"),
    readAt: timestamptz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_member_idx").on(
      t.memberId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("notifications_member_unread_idx")
      .on(t.memberId)
      .where(sql`${t.readAt} is null`),
    uniqueIndex("notifications_member_dedupe_unique")
      .on(t.memberId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index("notifications_thread_idx").on(t.threadId),
  ],
);

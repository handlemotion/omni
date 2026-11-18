import {
  bigint,
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { invitations, teams } from "../auth.ts";
import { id, orgId, memberId, timestamptz, createdAt, updatedAt } from "../columns.ts";
import {
  mailboxKind,
  mailProvider,
  forwardScope,
  mailboxStatus,
  folderRole,
  mailboxAccessRole,
} from "./enums.ts";

/**
 * A forwarded message as `@omni/mail-core/clean` `cleanMessage` extracts it. Declared here, not
 * imported: the web app type-checks against this schema and must not pull in the Node-only parser.
 */
export interface ForwardedMessage {
  from: string | null;
  date: string | null;
  subject: string | null;
  to: string | null;
  /** The forwarded body, unstripped: it renders as a quoted card. */
  text: string;
}

export interface Address {
  name: string | null;
  address: string;
}

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
     * What its owner calls a personal inbox ("Work", "Personal"), shown in place of their name
     * wherever their inboxes are told apart. Null: unlabelled.
     */
    label: text("label"),
    /**
     * The account's own picture, as its provider gives it (Google's profile photo, saved when
     * the account is connected). Null: none known; clients fall back to the address's Gravatar.
     */
    picture: text("picture"),
    /**
     * The From display name for mail sent from a personal inbox ("Rodrigo @ Chow Mein"). Null:
     * the owner's own name.
     */
    senderName: text("sender_name"),
    /**
     * A shared mailbox's Better Auth team: its members are who can see it, and `mailbox_access`
     * is derived from them (ADR 0008). Null for personal mailboxes, and for a shared mailbox
     * until `ensureMailboxTeam` runs. Same org as the mailbox, enforced where it is read.
     */
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    /**
     * Shared inboxes: hand each new conversation to the next member in turn (round robin by
     * member id). `auto_assign_last_member_id` is whose turn it was last.
     */
    autoAssign: boolean("auto_assign").notNull().default(false),
    autoAssignLastMemberId: text("auto_assign_last_member_id"),
    /**
     * A CRM's forwarding address (ADR 0032): sends BCC it, received mail is forwarded to it per
     * `forward_scope`. Null is off. Personal mailboxes only. `forward_since` is when it was last
     * turned on: nothing older is forwarded, so a sync or import never floods the CRM.
     */
    forwardAddress: text("forward_address"),
    forwardScope: forwardScope("forward_scope").notNull().default("conversations"),
    forwardSince: timestamptz("forward_since"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mailboxes_org_id_address_unique").on(t.orgId, t.address),
    unique("mailboxes_team_id_unique").on(t.teamId),
    unique("mailboxes_id_org_id_unique").on(t.id, t.orgId),
  ],
);

/**
 * A personal inbox made with an invitation, waiting for the person to accept (ADR 0026). It sits
 * orphaned (no grant, not synced) until then; accepting gives it to the new member. Gone with the
 * invitation or the mailbox.
 */
export const invitationInboxes = pgTable(
  "invitation_inboxes",
  {
    orgId: orgId(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.invitationId, t.mailboxId] }),
    foreignKey({
      name: "invitation_inboxes_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
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

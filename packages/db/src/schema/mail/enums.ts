import { pgEnum } from "drizzle-orm/pg-core";

export const mailboxKind = pgEnum("mailbox_kind", ["personal", "shared"]);

export const mailProvider = pgEnum("mail_provider", ["purelymail", "gmail", "microsoft", "imap"]);

/** What a mailbox copies to its forwarding address. */
export const forwardScope = pgEnum("forward_scope", ["sent", "conversations", "all"]);

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
  "forward_copy",
  "archive",
  "move",
  "mark_read",
  "mark_unread",
  "trash",
  "spam",
  "not_spam",
]);

/**
 * A shared conversation's status: `open` waits on the team, `pending` on the customer,
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
  "merged",
  "handoff",
]);

export const draftKind = pgEnum("draft_kind", ["new", "reply", "forward"]);

export const mailActionStatus = pgEnum("mail_action_status", [
  "pending",
  "running",
  "done",
  "failed",
]);

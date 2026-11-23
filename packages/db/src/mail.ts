export { memberMail, userMail, type MemberQueries } from "./mail/queries.ts";
export {
  TRIAGE_AUTO_FILE_CONFIDENCE,
  LANES,
  type Lane,
  THREAD_VIEWS,
  type ThreadView,
  type ThreadCursor,
} from "./mail/inbox-views.ts";
export {
  CONVERSATION_VIEWS,
  type ConversationView,
  type ConversationCursor,
  SLA_AT_RISK_MINUTES,
} from "./mail/conversation-views.ts";
export type { Participant } from "./mail/grants.ts";
export {
  type ChangeFailure,
  type ChangeResult,
  type ConversationChange,
  type ConversationRow,
  type Executor,
  type NotificationKind,
  PRIORITIES,
  type Priority,
  type Status,
} from "./mail/conversation-core.ts";
export type { InboxAuditAction } from "./mail/inbox-admin.ts";
export * from "./mail/writers.ts";
export * from "./mail/mailbox-registry.ts";
export * from "./mail/folder-sync.ts";
export * from "./mail/threading.ts";
export * from "./mail/message-lifecycle.ts";
export * from "./mail/outbox.ts";
export * from "./mail/mailbox-credentials.ts";
export * from "./mail/thread-merge.ts";
export * from "./mail/pending-mail-events.ts";
export * from "./mail/system.ts";
export * from "./mail/member-mail.ts";
export * from "./mail/ai-jobs.ts";
export * from "./mail/ai-helpdesk.ts";
export * from "./mail/ai-settings.ts";
export * from "./mail/thread-filters.ts";
export * from "./mail/placement.ts";
export { mailboxCount } from "./mail/mailbox-count.ts";
export * from "./mail/mailbox-teams.ts";
export * from "./mail/workspace-mailboxes.ts";
export * from "./mail/workspace-members.ts";
export * from "./mail/inbox-admin.ts";
export * from "./mail/compose.ts";
export * from "./mail/library.ts";
export * from "./mail/customers.ts";
export * from "./mail/arrivals.ts";
export * from "./mail/drafts.ts";
export * from "./mail/conversations.ts";
export {
  ARCHIVE_DELAY_SECONDS,
  type Applied,
  applyStatus,
  assign,
} from "./mail/conversation-steps.ts";
export { applyInboundMessage, type InboundResult } from "./mail/conversation-inbound.ts";
export * from "./mail/conversation-sweeps.ts";
export { setAutoAssign } from "./mail/auto-assign.ts";
export * from "./mail/handoff.ts";
export * from "./mail/conversation-tags.ts";
export * from "./mail/conversation-notes.ts";
export * from "./mail/sla.ts";
export * from "./mail/forwarding.ts";
export * from "./mail/mailbox-label.ts";
export * from "./mail/dead-letters.ts";
export * from "./mail/for-platform.ts";
export * from "./mail/unsubscribes.ts";
export {
  indexParticipants,
  participantsOf,
  PARTICIPANT_BATCH,
  PARTICIPANT_SETTLE_MS,
} from "./mail/thread-participants.ts";
export { THREADS_WITH_MAX, type ThreadsWithOptions, type ThreadWith } from "./mail/threads-with.ts";
export {
  CRM_SHARING_LEVELS,
  SHARED_ACTIVITY_MAX,
  type CrmSharingLevel,
  type CrmSharingResult,
  type SharedActivity,
  type SharedActivityOptions,
} from "./mail/crm-sharing.ts";
export {
  CALENDAR_ATTACHMENTS_MAX,
  calendarAttachments,
  calendarAttachmentsOf,
  type CalendarAttachment,
} from "./mail/calendar-attachments.ts";
export { replyHeadersOf } from "./mail/message-headers.ts";

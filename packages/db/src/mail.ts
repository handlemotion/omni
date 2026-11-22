export {
  memberMail,
  userMail,
  TRIAGE_AUTO_FILE_CONFIDENCE,
  LANES,
  type Lane,
  THREAD_VIEWS,
  type ThreadView,
  CONVERSATION_VIEWS,
  type ConversationView,
  type ConversationCursor,
  type ThreadCursor,
  SLA_AT_RISK_MINUTES,
  type Participant,
  type MemberQueries,
} from "./mail/queries.ts";
export type { Executor, NotificationKind } from "./mail/conversation-core.ts";
export type { InboxAuditAction } from "./mail/inbox-admin.ts";
export * from "./mail/writers.ts";
export * from "./mail/mail-sync.ts";
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

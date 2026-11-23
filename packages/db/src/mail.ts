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
export {
  createThread,
  findThreadByProviderId,
  claimProviderThread,
  findThreadByMessageIds,
  upsertMessage,
  refreshListUnsubscribe,
  upsertFolder,
  type MailActionRequest,
  enqueueAction,
  claimActions,
  completeAction,
} from "./mail/writers.ts";
export {
  listServiceMailboxes,
  findMailbox,
  setMailboxStatus,
  findMemberByEmail,
  findMailboxByAddress,
  saveMailbox,
  mailboxOwnerIds,
  liveGmailMailboxes,
  findGmailMailboxes,
  findOrgMailboxById,
  deleteMailbox,
} from "./mail/mailbox-registry.ts";
export {
  replaceFolders,
  getFolderPosition,
  saveFolderPosition,
  folderLocations,
  hasLocation,
  findFolder,
  addLocation,
  setLocationFlags,
  removeLocations,
  reconcileFolder,
  resetFolder,
} from "./mail/folder-sync.ts";
export {
  findMessageByHeader,
  threadsByMessageIds,
  threadReferencing,
  threadsReplyingTo,
  subjectThreadCandidates,
  messageThread,
  moveMessageToThread,
} from "./mail/threading.ts";
export {
  orphanedMessages,
  pruneMessages,
  pendingNotifications,
  markNotified,
} from "./mail/message-lifecycle.ts";
export {
  sendAttachmentFiles,
  nextActionDue,
  markActionSmtpAccepted,
  rescheduleAction,
  deferAction,
} from "./mail/outbox.ts";
export { replaceMailboxCredentials } from "./mail/mailbox-credentials.ts";
export { type MergedThreads, mergeThreads } from "./mail/thread-merge.ts";
export { pendingMailEventRows, deletePendingMailEvents } from "./mail/pending-mail-events.ts";
export { mailboxAudience, pushTokensFor } from "./mail/system.ts";
export {
  listMemberMailboxes,
  threadActionTargets,
  setThreadArchived,
  findMemberAttachmentByHash,
  findMemberAttachment,
  findMemberMessageHtml,
  resortThread,
} from "./mail/member-mail.ts";
export { mailObjectKeys } from "./schema/mail/messages.ts";
export {
  loadThreadForAi,
  saveTriage,
  saveSummary,
  addAiUsage,
  markTriagePaused,
} from "./mail/ai-jobs.ts";
export { awaitingIngest, helpdeskContextForAi, applyAiHelpdeskTriage } from "./mail/ai-helpdesk.ts";
export {
  MAX_ROLE_DESCRIPTION,
  listMemberRoleDescriptions,
  setMemberRoleDescription,
} from "./mail/ai-settings.ts";
export { type MessageFilters, type ThreadFilters } from "./mail/thread-filters.ts";
export {
  placeForAddress,
  type MisplacedMailbox,
  listMisplacedMailboxes,
  hasUnsyncedWork,
  firstSyncDone,
  carryThreadState,
} from "./mail/placement.ts";
export { mailboxCount } from "./mail/mailbox-count.ts";
export * from "./mail/mailbox-teams.ts";
export { listWorkspaceMailboxes, mailboxAtAddress, orgMember } from "./mail/workspace-mailboxes.ts";
export {
  listWorkspaceMembers,
  memberInboxCount,
  hasSharedGrant,
  membersStrandedWithout,
} from "./mail/workspace-members.ts";
export {
  type InboxAuditAction,
  recordInboxEvent,
  listInboxEvents,
  type OrphanResult,
  giveOrphanedInbox,
  shareOrphanedInbox,
  reserveInvitationInbox,
  claimInvitationInboxes,
} from "./mail/inbox-admin.ts";
export {
  memberMailbox,
  senderIdentity,
  newUploadId,
  uploadKey,
  createUpload,
  memberUpload,
  deleteUnsentUpload,
  enqueueSendWithAttachments,
  takeExpiredUploads,
  memberSignatures,
  setSignature,
  deleteSignature,
} from "./mail/compose.ts";
export {
  listCannedReplies,
  getCannedReply,
  type CannedReplyScope,
  type CannedReplyWriteError,
  createCannedReply,
  updateCannedReply,
  deleteCannedReply,
  templateContext,
} from "./mail/library.ts";
export { recordCustomer, searchCustomers, customerProfile } from "./mail/customers.ts";
export { newArrivals } from "./mail/arrivals.ts";
export {
  undoSendSeconds,
  cancelSend,
  listDrafts,
  getDraft,
  createDraft,
  saveDraft,
  deleteDraft,
  memberSendByKey,
} from "./mail/drafts.ts";
export { applyConversationChange, applyAgentReply } from "./mail/conversations.ts";
export {
  ARCHIVE_DELAY_SECONDS,
  type Applied,
  applyStatus,
  assign,
} from "./mail/conversation-steps.ts";
export { applyInboundMessage, type InboundResult } from "./mail/conversation-inbound.ts";
export {
  discardedConversations,
  resolveDiscarded,
  dueSnoozes,
} from "./mail/conversation-sweeps.ts";
export { setAutoAssign } from "./mail/auto-assign.ts";
export { enqueueHandoff } from "./mail/handoff.ts";
export { createTag, updateTag, deleteTag } from "./mail/conversation-tags.ts";
export { NOTE_MAX_LENGTH, createNote, updateNote, deleteNote } from "./mail/conversation-notes.ts";
export {
  putSlaPolicy,
  deleteSlaPolicy,
  putBusinessHours,
  deleteBusinessHours,
  emitSlaAlerts,
} from "./mail/sla.ts";
export {
  forwardTarget,
  forwardCopySource,
  enqueueForwardCopies,
  forwardingFor,
} from "./mail/forwarding.ts";
export { setInboxNames, mailboxSenderName } from "./mail/mailbox-label.ts";
export { recordDeadLetter, listDeadLetters } from "./mail/dead-letters.ts";
export {
  orgHasMailbox,
  countMailboxesOnDomain,
  findOrgMailbox,
  mailboxesOpenTo,
  omniHostedAddresses,
} from "./mail/for-platform.ts";
export { recordUnsubscribe } from "./mail/unsubscribes.ts";
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

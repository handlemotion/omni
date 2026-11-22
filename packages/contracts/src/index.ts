import { z } from "zod";

export * from "./storage.ts";
export * from "./storage-live.ts";
export * from "./storage-teamspaces.ts";
export * from "./crm.ts";
export * from "./crm-access.ts";
export * from "./crm-links.ts";
export * from "./crm-plan.ts";
export * from "./crm-portal.ts";
export * from "./crm-tasks.ts";
export * from "./invitations.ts";
export * from "./mail.ts";
export * from "./errors.ts";
export * from "./error-schemas.ts";

/** Worker → mail service: "the outbox or the mailbox list changed". Empty body. 202 or 401. */
export const MAIL_PING_PATH = "/ping";

/** Mail service → Worker: new mail was indexed. JSON `MailEventsBody`. Any 2xx accepts. */
export const MAIL_EVENTS_PATH = "/internal/mail-events";

export const folderRoleSchema = z.enum([
  "inbox",
  "sent",
  "archive",
  "trash",
  "other",
  "junk",
  "drafts",
]);

/**
 * A message row was created (never for a second copy of a known message). Delivery is at least
 * once, so receivers must be idempotent per `messageId`.
 */
export const messageCreatedEventSchema = z.object({
  type: z.literal("message.created"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  threadId: z.string().min(1),
  /** `messages.id`. */
  messageId: z.string().min(1),
  folderRole: folderRoleSchema,
});

/**
 * An outbox action failed for good: no more retries. The Worker tells the member who asked for
 * it, so a send shows as failed. At least once, like every event; receivers key on `actionId`.
 */
export const actionFailedEventSchema = z.object({
  type: z.literal("action.failed"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  actionId: z.string().min(1),
  /** Null for system mail (magic links, invitations): nobody to tell. */
  memberId: z.string().min(1).nullable(),
  error: z.string(),
  /** The request that asked for the action, for tracing. Absent from older senders. */
  requestId: z.string().nullable().optional(),
});

/** Thread ids one `messages.pruned` event carries at most; the mail service splits the rest. */
export const MAX_PRUNED_THREADS_PER_EVENT = 500;

/**
 * Messages deleted on the server were removed from the index. `threadIds` are the
 * threads that lost messages; any of them may be gone too, if it was left empty. The Worker
 * refreshes those threads for open apps and re-runs triage and summary on the ones that remain,
 * whose latest message may have changed. At least once; both are idempotent.
 */
export const messagesPrunedEventSchema = z.object({
  type: z.literal("messages.pruned"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  threadIds: z.array(z.string().min(1)).min(1).max(MAX_PRUNED_THREADS_PER_EVENT),
});

/**
 * Threads that turned out to be one conversation were merged: `fromThreadIds` are gone and their
 * messages and helpdesk state are on `intoThreadId`. The Worker refreshes all of them for open
 * apps, so a reader showing a merged thread can move to the survivor. At least once; idempotent.
 */
export const threadsMergedEventSchema = z.object({
  type: z.literal("threads.merged"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  intoThreadId: z.string().min(1),
  fromThreadIds: z.array(z.string().min(1)).min(1),
});

/**
 * Shared conversations whose mail was all moved to Trash or Junk in another mail app (Apple
 * Mail's delete), found at the end of a full sync. The Worker resolves each one that still
 * qualifies (`resolveDiscarded`) and refreshes open apps. Sent again by every full sync until
 * resolved, so a lost event only delays it; idempotent.
 */
export const threadsDiscardedEventSchema = z.object({
  type: z.literal("threads.discarded"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  threadIds: z.array(z.string().min(1)).min(1).max(MAX_PRUNED_THREADS_PER_EVENT),
});

/**
 * Threads whose state changed in another mail app: a message was read, flagged, archived or moved
 * there, and the index followed. Sent only when a thread's derived state actually
 * changed, so no new mail and nothing for AI. The Worker refreshes those threads for open apps.
 * At least once; idempotent.
 */
export const threadsChangedEventSchema = z.object({
  type: z.literal("threads.changed"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  threadIds: z.array(z.string().min(1)).min(1).max(MAX_PRUNED_THREADS_PER_EVENT),
});

export const mailEventSchema = z.discriminatedUnion("type", [
  messageCreatedEventSchema,
  actionFailedEventSchema,
  messagesPrunedEventSchema,
  threadsMergedEventSchema,
  threadsDiscardedEventSchema,
  threadsChangedEventSchema,
]);

export const MAX_EVENTS_PER_REQUEST = 100;

export const mailEventsBodySchema = z.object({
  events: z.array(mailEventSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
});

export type MailEvent = z.infer<typeof mailEventSchema>;
export type MailEventsBody = z.infer<typeof mailEventsBodySchema>;

/** UIDs mean nothing without their folder's UIDVALIDITY; a mismatch fails the action. */
export const messageTargetSchema = z.object({
  folder: z.string().min(1),
  /** Decimal string: JSON has no bigint. */
  uidValidity: z.string().regex(/^\d+$/),
  uids: z.array(z.number().int().positive()).min(1),
});

/**
 * `done`: the flag carries Done to a Google account, where Gmail's read is Omni's Done. There the mail service runs only these, and drops a plain read or unread: Omni's read
 * state is not Gmail's, whatever a Worker from before that rule still queues.
 */
export const flagTargetSchema = messageTargetSchema.extend({ done: z.literal(true).optional() });

/** The most files one sent message may carry. */
export const MAX_SEND_ATTACHMENTS = 50;

export const sendAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), uploadId: z.string().min(1) }),
  z.object({ kind: z.literal("attachment"), attachmentId: z.string().min(1) }),
]);

export const sendPayloadSchema = z.object({
  /** The address sent from: on a shared inbox, the inbox's address. */
  from: z.string().min(1),
  /** Display name on From: on a shared inbox, the agent's name (`Ana from Acme`). */
  fromName: z.string().min(1).optional(),
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  /** Message-ID of the message being replied to, in `<id@host>` form. */
  inReplyTo: z.string().optional(),
  /** Full References chain of the reply, oldest first. */
  references: z.array(z.string()).optional(),
  /**
   * `messages.id` of the message replied to or forwarded, so the sent copy is stored in its
   * thread as soon as SMTP accepts it. Reply headers still come from `inReplyTo`/`references`.
   */
  inReplyToMessageId: z.string().min(1).optional(),
  attachments: z.array(sendAttachmentSchema).max(MAX_SEND_ATTACHMENTS).optional(),
  /**
   * A hand-off: the shared conversation (`threads.id`, another mailbox's) this reply
   * from a personal mailbox takes over. The Worker reads it when the send is cancelled, to undo
   * the hand-off; the mail service ignores it.
   */
  handoffThreadId: z.string().min(1).optional(),
  /**
   * Message-ID to send with, in `<id@host>` form, chosen by the Worker so the app knows it before
   * the mail goes out. Absent: the mail service derives one from the idempotency key.
   */
  messageId: z
    .string()
    .regex(/^<[^<>\s@]+@[^<>\s@]+>$/)
    .optional(),
});

/** A copy of a received message for the mailbox's forwarding address. */
export const forwardCopyPayloadSchema = z.object({
  /** `messages.id` of the received message. */
  messageId: z.string().min(1),
});

export const actionPayloadSchemas = {
  send: sendPayloadSchema,
  forward_copy: forwardCopyPayloadSchema,
  archive: messageTargetSchema,
  move: messageTargetSchema.extend({ destination: z.string().min(1) }),
  mark_read: flagTargetSchema,
  mark_unread: flagTargetSchema,
  /** Move to the mailbox's trash folder (`folder_role` trash). */
  trash: messageTargetSchema,
  /** Move to the junk folder (`folder_role` junk). */
  spam: messageTargetSchema,
  /** Move from junk back to INBOX. */
  not_spam: messageTargetSchema,
} as const;

export type MailActionKind = keyof typeof actionPayloadSchemas;
export type MessageTarget = z.infer<typeof messageTargetSchema>;
export type SendPayload = z.infer<typeof sendPayloadSchema>;
export type ForwardCopyPayload = z.infer<typeof forwardCopyPayloadSchema>;
export type SendAttachment = z.infer<typeof sendAttachmentSchema>;
export type ActionPayload<K extends MailActionKind> = z.infer<(typeof actionPayloadSchemas)[K]>;

const realtimeBase = { mailboxId: z.string().min(1) };

/** Conversation state changed: status, assignee, priority, tags, snooze, or a new message. */
export const threadChangedRealtimeSchema = z.object({
  type: z.literal("thread.changed"),
  ...realtimeBase,
  threadIds: z.array(z.string().min(1)).min(1),
});

export const noteCreatedRealtimeSchema = z.object({
  type: z.literal("note.created"),
  ...realtimeBase,
  threadId: z.string().min(1),
  noteId: z.string().min(1),
});

/** Who is looking at or replying in a conversation. `left` clears them. */
export const presenceRealtimeSchema = z.object({
  type: z.literal("presence"),
  ...realtimeBase,
  threadId: z.string().min(1),
  memberId: z.string().min(1),
  state: z.enum(["viewing", "replying", "left"]),
});

/** An outbox action finished: a send went out, or a move landed on IMAP. */
export const actionSucceededRealtimeSchema = z.object({
  type: z.literal("action.succeeded"),
  ...realtimeBase,
  actionId: z.string().min(1),
  kind: z.enum(Object.keys(actionPayloadSchemas) as [MailActionKind, ...MailActionKind[]]),
});

export const slaTargetSchema = z.enum(["first_response", "next_response", "resolution"]);

const slaRealtime = {
  ...realtimeBase,
  threadId: z.string().min(1),
  target: slaTargetSchema,
  dueAt: z.iso.datetime({ offset: true }),
};

export const slaAtRiskRealtimeSchema = z.object({ type: z.literal("sla.at_risk"), ...slaRealtime });
export const slaBreachedRealtimeSchema = z.object({
  type: z.literal("sla.breached"),
  ...slaRealtime,
});

export const helpdeskRealtimeEventSchema = z.discriminatedUnion("type", [
  threadChangedRealtimeSchema,
  noteCreatedRealtimeSchema,
  presenceRealtimeSchema,
  actionSucceededRealtimeSchema,
  slaAtRiskRealtimeSchema,
  slaBreachedRealtimeSchema,
]);

export type HelpdeskRealtimeEvent = z.infer<typeof helpdeskRealtimeEventSchema>;
export type SlaTarget = z.infer<typeof slaTargetSchema>;

export const PROVISION_DOMAIN_PATH = "/provision/domain";
export const PROVISION_MAILBOX_PATH = "/provision/mailbox";

export const dnsRecordStatusSchema = z.object({
  check: z.enum(["ownership", "mx", "spf", "dkim", "dmarc"]),
  type: z.enum(["TXT", "MX", "CNAME"]),
  name: z.string(),
  value: z.string(),
  priority: z.number().int().optional(),
  verified: z.boolean(),
});

/**
 * Add `domain` at the provider if it is not there yet, then re-check its DNS. Idempotent. With
 * `add: false` only the records and their current state are read: the Worker asks for those
 * before the domain is locked to an org, and adds it at the provider only after.
 */
export const provisionDomainBodySchema = z.object({
  /** Already normalized (`normalizeDomain` from `@omni/mail-core/domains`). */
  domain: z.string().min(1),
  add: z.boolean().default(true),
});

export const provisionDomainResultSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("purelymail"),
    /** On the Purelymail account. False until the ownership record is in DNS. */
    added: z.boolean(),
    records: z.array(dnsRecordStatusSchema),
    /** Why Purelymail refused to add it, in its own words. */
    addError: z.string().optional(),
  }),
  z.object({ provider: z.literal("imap") }),
]);

const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535),
  secure: z.boolean(),
});

/**
 * Create the mailbox and start syncing it. Idempotent on (orgId, address): a Purelymail mailbox
 * that exists is returned as is (no second app password); an IMAP one gets the new login.
 */
export const provisionMailboxBodySchema = z.object({
  orgId: z.string().min(1),
  /** Already normalized, on a domain the org has claimed. */
  address: z.string().min(3),
  kind: z.enum(["personal", "shared"]),
  /**
   * Gets an owner grant in `mailbox_access`. Null only for a personal inbox made with an
   * invitation: it waits with no owner until the person accepts.
   */
  ownerMemberId: z.string().min(1).nullable(),
  login: z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("purelymail") }),
    z.object({
      provider: z.literal("imap"),
      user: z.string().min(1),
      pass: z.string().min(1),
      imap: serverSchema,
      smtp: serverSchema,
    }),
  ]),
});

export const provisionMailboxResultSchema = z.object({
  mailboxId: z.string().min(1),
  address: z.string(),
  /** False when the mailbox already existed and nothing changed. */
  created: z.boolean(),
});

/**
 * Ask the domain's own nameservers. The mail service finds the zone's NS records and
 * queries those servers directly, so an answer reflects a record seconds after it is saved
 * instead of after a public resolver's cache expires. Names must be `domain` or under it.
 */
export const DNS_LOOKUP_PATH = "/dns/lookup";

export const dnsQueryTypeSchema = z.enum(["TXT", "MX", "CNAME", "NS"]);

export const dnsLookupBodySchema = z.object({
  /** Already normalized; its zone's nameservers answer every query. */
  domain: z.string().min(1).max(253),
  queries: z
    .array(z.object({ name: z.string().min(1).max(253), type: dnsQueryTypeSchema }))
    .min(1)
    .max(32),
});

export const dnsAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), values: z.array(z.string()) }),
  z.object({ status: z.literal("nxdomain") }),
  z.object({ status: z.literal("nodata") }),
  z.object({ status: z.literal("error"), code: z.string() }),
]);

export const dnsLookupResultSchema = z.object({
  /** The zone the domain is in, and its nameservers; null when no NS records were found. */
  zone: z.string().nullable(),
  nameservers: z.array(z.string()),
  answers: z.array(
    z.object({
      name: z.string(),
      type: dnsQueryTypeSchema,
      /** `authoritative`: from the zone's nameservers. `recursive`: they could not be reached. */
      source: z.enum(["authoritative", "recursive"]),
      answer: dnsAnswerSchema,
    }),
  ),
});

export type DnsRecordStatus = z.infer<typeof dnsRecordStatusSchema>;
export type DnsQueryType = z.infer<typeof dnsQueryTypeSchema>;
export type DnsAnswer = z.infer<typeof dnsAnswerSchema>;
export type DnsLookupBody = z.infer<typeof dnsLookupBodySchema>;
export type DnsLookupResult = z.infer<typeof dnsLookupResultSchema>;
export type ProvisionDomainBody = z.infer<typeof provisionDomainBodySchema>;
export type ProvisionDomainResult = z.infer<typeof provisionDomainResultSchema>;
export type ProvisionMailboxBody = z.infer<typeof provisionMailboxBodySchema>;
export type ProvisionMailboxResult = z.infer<typeof provisionMailboxResultSchema>;

export const GOOGLE_CONNECT_PATH = "/connect/google";
export const GOOGLE_DISCONNECT_PATH = "/connect/google/disconnect";

export const googleConnectBodySchema = z.object({
  orgId: z.string().min(1),
  /** Gets an owner grant on the mailbox. */
  memberId: z.string().min(1),
  /**
   * With it, the account goes where its address belongs: the company that locked its
   * domain, if this person is a member there, else their Personal space. `orgId` and `memberId`
   * are then ignored. Without it, the account goes to `orgId` as before.
   */
  userId: z.string().min(1).optional(),
  /** A session scoped to one company may connect only into it. */
  scopeOrgId: z.string().min(1).optional(),
  /** Google's one-time authorization code. Never logged. */
  code: z.string().min(1),
  /** PKCE verifier for the code (RFC 7636). Never logged. */
  codeVerifier: z.string().min(43).max(128),
  /** The redirect URI the code was issued for; Google requires the same one on exchange. */
  redirectUri: z.url(),
});

export const googleConnectResultSchema = z.object({
  mailboxId: z.string().min(1),
  /** The Google account's address. */
  address: z.string(),
  /** False when an existing mailbox was reconnected (new refresh token). */
  created: z.boolean(),
  /** The workspace it landed in. Absent from mail services that predate workspaces. */
  orgId: z.string().optional(),
});

/** Revoke the token at Google, forget it, and stop syncing. Idempotent. */
export const googleDisconnectBodySchema = z.object({
  orgId: z.string().min(1),
  memberId: z.string().min(1),
  mailboxId: z.string().min(1),
  /**
   * With it, the owner is this person's member in the mailbox's own workspace, wherever that is;
   * `orgId` and `memberId` are then ignored.
   */
  userId: z.string().min(1).optional(),
});

export const googleDisconnectResultSchema = z.object({ mailboxId: z.string().min(1) });

export const HOSTED_DISCONNECT_PATH = "/hosting/mailbox/disconnect";

/** Idempotent: a mailbox already gone answers with its id. */
export const hostedDisconnectBodySchema = z.object({
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
});

export const hostedDisconnectResultSchema = z.object({ mailboxId: z.string().min(1) });

export type HostedDisconnectBody = z.infer<typeof hostedDisconnectBodySchema>;

/**
 * Removing any mailbox of an org from Omni, whatever its provider. Same body and
 * answer as the hosted path; the Worker checks the member is an owner or admin.
 */
export const MAILBOX_DISCONNECT_PATH = "/mailbox/disconnect";

export type GoogleConnectBody = z.infer<typeof googleConnectBodySchema>;
export type GoogleConnectResult = z.infer<typeof googleConnectResultSchema>;
export type GoogleDisconnectBody = z.infer<typeof googleDisconnectBodySchema>;

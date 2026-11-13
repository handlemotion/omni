// Wire contracts between the Worker and the mail service. Both directions are HMAC-signed with
// `signRequest` / `verifyRequest` from `@omni/crypto` over the exact path and body below.
import { z } from "zod";

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
 * Messages deleted on the server were removed from the index (ADR 0013). `threadIds` are the
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
 * there, and the index followed (ADR 0013). Sent only when a thread's derived state actually
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

// `mail_actions.payload` per `kind`. The Worker writes them; the mail service validates before
// acting, and an invalid payload fails the action without retrying.

/** UIDs mean nothing without their folder's UIDVALIDITY; a mismatch fails the action. */
export const messageTargetSchema = z.object({
  folder: z.string().min(1),
  /** Decimal string: JSON has no bigint. */
  uidValidity: z.string().regex(/^\d+$/),
  uids: z.array(z.number().int().positive()).min(1),
});

/**
 * A file to attach to a send: one uploaded for it (`uploads.id`), or an attachment of a stored
 * message in the same mailbox (`attachments.id`), which is how forward keeps the originals. The
 * mail service streams each from R2 into the MIME.
 */
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
   * Message-ID to send with, in `<id@host>` form, chosen by the Worker so the app knows it before
   * the mail goes out. Absent: the mail service derives one from the idempotency key.
   */
  messageId: z
    .string()
    .regex(/^<[^<>\s@]+@[^<>\s@]+>$/)
    .optional(),
});

export const actionPayloadSchemas = {
  send: sendPayloadSchema,
  archive: messageTargetSchema,
  move: messageTargetSchema.extend({ destination: z.string().min(1) }),
  mark_read: messageTargetSchema,
  mark_unread: messageTargetSchema,
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
export type SendAttachment = z.infer<typeof sendAttachmentSchema>;
export type ActionPayload<K extends MailActionKind> = z.infer<(typeof actionPayloadSchemas)[K]>;

// Helpdesk realtime events (ADR 0021): Worker → apps over the realtime socket, alongside the
// Worker's existing `changed`/`action`/`mailbox`/`domain` events. They carry ids, never mail
// content: a client refetches what it shows. Apps ignore types they do not know.

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
  /** ISO 8601. */
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

// Onboarding: provisioning domains and mailboxes. Worker → mail service, signed like the ping
// (with a nonce), JSON in and out. Only the mail service holds the Purelymail token and mailbox
// passwords; these calls are how the Worker asks it to use them. Errors answer
// `{ error: string }` with a status the Worker passes on: 400 bad input, 409 conflict or
// provider unavailable, 422 the mail host refused (bad login), 502 the provider API failed.

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
 * before the domain is locked to an org, and adds it at the provider only after (ADR 0010).
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
  /** No provider API here: mailboxes are existing IMAP/SMTP logins, and DNS is the host's. */
  z.object({ provider: z.literal("imap") }),
]);

const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535),
  /** Implicit TLS (993, 465). False: STARTTLS when the server offers it. */
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
  /** Gets an owner grant in `mailbox_access`. */
  ownerMemberId: z.string().min(1),
  login: z.discriminatedUnion("provider", [
    /** The mail service creates the user and an app password. */
    z.object({ provider: z.literal("purelymail") }),
    /** An existing login, checked over IMAP before it is stored. Never logged. */
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
 * Ask the domain's own nameservers (ADR 0010). The mail service finds the zone's NS records and
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
  /**
   * TXT: each record's strings joined. MX: `"<priority> <host>"`. CNAME and NS: the host. Hosts
   * are lowercase with no trailing dot.
   */
  z.object({ status: z.literal("found"), values: z.array(z.string()) }),
  /** The name does not exist. */
  z.object({ status: z.literal("nxdomain") }),
  /** The name exists but has no record of this type (or only a CNAME, for TXT and MX). */
  z.object({ status: z.literal("nodata") }),
  /** No answer (timeout, SERVFAIL, refused): says nothing about the record. */
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

// Personal Gmail (helpdesk plan G1-G3). Worker → mail service, signed with a nonce like
// provisioning. The Worker receives Google's OAuth callback but never sees a token: it passes the
// one-time code (and its PKCE verifier) to the mail service, which exchanges it, stores the
// encrypted refresh token and creates or reconnects the member's personal `gmail` mailbox.
// Errors answer `{ error: string }` with 400 (bad or expired code), 409 (that Google account is
// connected elsewhere) or 502 (Google failed).

export const GOOGLE_CONNECT_PATH = "/connect/google";
export const GOOGLE_DISCONNECT_PATH = "/connect/google/disconnect";

export const googleConnectBodySchema = z.object({
  orgId: z.string().min(1),
  /** Gets an owner grant on the mailbox. */
  memberId: z.string().min(1),
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
});

/** Revoke the token at Google, forget it, and stop syncing. Idempotent. */
export const googleDisconnectBodySchema = z.object({
  orgId: z.string().min(1),
  memberId: z.string().min(1),
  mailboxId: z.string().min(1),
});

export const googleDisconnectResultSchema = z.object({ mailboxId: z.string().min(1) });

export type GoogleConnectBody = z.infer<typeof googleConnectBodySchema>;
export type GoogleConnectResult = z.infer<typeof googleConnectResultSchema>;
export type GoogleDisconnectBody = z.infer<typeof googleDisconnectBodySchema>;

// Wire contracts between the Worker and the mail service. Both directions are HMAC-signed with
// `signRequest` / `verifyRequest` from `@omni/crypto` over the exact path and body below.
import { z } from "zod";

/** Worker → mail service: "the outbox or the mailbox list changed". Empty body. 202 or 401. */
export const MAIL_PING_PATH = "/ping";

/** Mail service → Worker: new mail was indexed. JSON `MailEventsBody`. Any 2xx accepts. */
export const MAIL_EVENTS_PATH = "/internal/mail-events";

export const folderRoleSchema = z.enum(["inbox", "sent", "archive", "trash", "other"]);

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

export const mailEventSchema = z.discriminatedUnion("type", [
  messageCreatedEventSchema,
  actionFailedEventSchema,
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

export const sendPayloadSchema = z.object({
  from: z.string().min(1),
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
} as const;

export type MailActionKind = keyof typeof actionPayloadSchemas;
export type MessageTarget = z.infer<typeof messageTargetSchema>;
export type SendPayload = z.infer<typeof sendPayloadSchema>;
export type ActionPayload<K extends MailActionKind> = z.infer<(typeof actionPayloadSchemas)[K]>;

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

/** Add `domain` at the provider if it is not there yet, then re-check its DNS. Idempotent. */
export const provisionDomainBodySchema = z.object({
  /** Already normalized (`normalizeDomain` from `@omni/mail-core/domains`). */
  domain: z.string().min(1),
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

export type DnsRecordStatus = z.infer<typeof dnsRecordStatusSchema>;
export type ProvisionDomainBody = z.infer<typeof provisionDomainBodySchema>;
export type ProvisionDomainResult = z.infer<typeof provisionDomainResultSchema>;
export type ProvisionMailboxBody = z.infer<typeof provisionMailboxBodySchema>;
export type ProvisionMailboxResult = z.infer<typeof provisionMailboxResultSchema>;

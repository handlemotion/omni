// Wire contracts between the Worker and the mail service. Both directions are HMAC-signed with
// `signRequest` / `verifyRequest` from `@omni/crypto` over the exact path and body below.
import { z } from "zod";

/** Worker → mail service: "the outbox or the mailbox list changed". Empty body. 202 or 401. */
export const MAIL_PING_PATH = "/ping";

/**
 * Mail service → Worker: new mail was indexed, or an outbox action failed for good. JSON
 * `MailEventsBody`. Any 2xx accepts.
 */
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
 * An outbox action failed for good: the mail service stopped retrying it (`mail_actions.status`
 * is `failed`). The receiver reads the action's member, kind and error from `mail_actions`.
 * Delivery is at least once, so receivers must be idempotent per `actionId`.
 */
export const actionFailedEventSchema = z.object({
  type: z.literal("action.failed"),
  orgId: z.string().min(1),
  mailboxId: z.string().min(1),
  /** `mail_actions.id`. */
  actionId: z.string().min(1),
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

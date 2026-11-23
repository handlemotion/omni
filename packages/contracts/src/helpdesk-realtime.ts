import { z } from "zod";
import { actionPayloadSchemas, type MailActionKind } from "./mail-service.ts";

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

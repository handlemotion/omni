// Shapes every MCP tool returns (ADR 0029): people as `{ name, address }`, ISO times, a deep link
// on every thread, and nothing internal (storage keys, other members' state). Results go out as
// `structuredContent` plus the same JSON as text, which the spec and ChatGPT both ask for.
import { TRIAGE_AUTO_FILE_CONFIDENCE, type Lane, type Participant } from "@omni/db";
import { z } from "zod";

export const personSchema = z.object({ name: z.string().nullable(), address: z.string() });

export const threadSummarySchema = z.object({
  id: z.string(),
  subject: z.string(),
  url: z.string().describe("Open the thread in Omni. Cite it when you answer."),
  mailbox: z.string().describe("The inbox address it is in."),
  from: personSchema.nullable().describe("Who wrote the latest message."),
  participants: z.array(personSchema).describe("Everyone who wrote in the thread, first to last."),
  last_message_at: z.string(),
  message_count: z.number(),
  snippet: z.string().describe("The start of the latest message."),
  unread: z.boolean(),
  lane: z
    .enum(["needs_reply", "waiting_on_them", "fyi", "noise", "unsure"])
    .nullable()
    .describe("Triage: unsure when the AI was not confident; null before triage."),
  later: z.boolean(),
  done: z.boolean(),
  archived: z.boolean(),
  has_attachments: z.boolean(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** A thread's lane as the inbox shows it: the AI's bucket only when it was sure. */
export function laneOf(thread: {
  triage: string | null;
  triageSource: string | null;
  triageConfidence: number | null;
}): Lane | null {
  if (!thread.triage) return null;
  if (
    thread.triageSource === "ai" &&
    (thread.triageConfidence ?? 0) < TRIAGE_AUTO_FILE_CONFIDENCE
  ) {
    return "unsure";
  }
  return thread.triage as Lane;
}

/** Where a thread opens in the web app. */
export function threadUrl(webAppURL: string, threadId: string) {
  return new URL(`/all/${encodeURIComponent(threadId)}`, webAppURL).toString();
}

/** The fields `listThreads` rows carry, as a tool returns them. */
export function threadSummary(
  row: {
    id: string;
    mailboxId: string;
    subject: string;
    snippet: string;
    latestFrom: Participant | null;
    participants: Participant[];
    lastMessageAt: Date;
    messageCount: number;
    unread: boolean;
    later: boolean;
    done: boolean;
    archived: boolean;
    hasAttachments: boolean;
    triage: string | null;
    triageSource: string | null;
    triageConfidence: number | null;
  },
  context: { webAppURL: string; mailboxAddress: (id: string) => string },
): ThreadSummary {
  return {
    id: row.id,
    subject: row.subject,
    url: threadUrl(context.webAppURL, row.id),
    mailbox: context.mailboxAddress(row.mailboxId),
    from: row.latestFrom,
    participants: row.participants,
    last_message_at: row.lastMessageAt.toISOString(),
    message_count: row.messageCount,
    snippet: row.snippet,
    unread: row.unread,
    lane: laneOf(row),
    later: row.later,
    done: row.done,
    archived: row.archived,
    has_attachments: row.hasAttachments,
  };
}

/** A tool result: the JSON as `structuredContent` and as text. */
export function result<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/** A tool error the agent can act on: one sentence saying what to do instead. */
export function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

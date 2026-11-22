import { and, eq } from "drizzle-orm";
import type { Executor } from "./conversation-core.ts";
import { messages } from "../schema/index.ts";

/**
 * What a reply to `messageId` threads on: its Message-ID and References, and its thread. Only
 * for a message in `mailboxId`, which the caller has already checked the member can open.
 */
export async function replyHeadersOf(
  db: Executor,
  input: { mailboxId: string; messageId: string },
) {
  const [row] = await db
    .select({
      threadId: messages.threadId,
      messageIdHeader: messages.messageIdHeader,
      references: messages.references,
    })
    .from(messages)
    .where(and(eq(messages.id, input.messageId), eq(messages.mailboxId, input.mailboxId)));
  return row ?? null;
}

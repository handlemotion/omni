// The reply-collision precondition (sync plan B1): a reply or forward names the latest message
// its composer showed, and is refused while the thread has a newer one. It guards teammates'
// sends only; nothing in Omni sends to customers on its own.
import type { forMember } from "@omni/db";
import { z } from "zod";
import { notFound } from "./mail.ts";

/**
 * The latest message the composer showed (`messages.id`). When the thread has a newer one, the
 * send answers 409 with those messages instead of going out, so a teammate never answers over a
 * customer's follow-up or a colleague's reply they have not seen. Absent skips the check.
 */
export const basedOnMessageId = z.string().min(1).optional();

type ThreadMessage = NonNullable<
  Awaited<ReturnType<ReturnType<typeof forMember>["getThread"]>>
>["messages"][number];

/** Answered (409) when a reply or forward was written against an older view of the thread. */
export class StaleThread extends Error {
  readonly messages: ThreadMessage[];
  constructor(messages: ThreadMessage[]) {
    super("the thread has newer messages");
    this.messages = messages;
  }
}

/**
 * Throws `StaleThread` with the messages after `basedOnMessageId`, in the order the thread shows
 * them (sent time, then id). Automated mail (bounces, auto-replies) does not count, as the
 * helpdesk ignores it too. An id that is not in the thread is 404, like an unknown `messageId`.
 */
export function assertLatest(messages: ThreadMessage[], basedOnMessageId: string | undefined) {
  if (!basedOnMessageId) return;
  const index = messages.findIndex((m) => m.id === basedOnMessageId);
  if (index === -1) notFound();
  const newer = messages.slice(index + 1).filter((m) => !m.automated);
  if (newer.length) throw new StaleThread(newer);
}

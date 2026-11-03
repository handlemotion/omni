import type { Address, ParsedMessage } from "./parse.ts";

// Reply and forward prefixes across common clients and locales: Re, Fwd, Fw, AW (de),
// WG (de), SV (sv/da/no), VS (fi), TR (fr), RV/RE (es), Enc (pt), Antw (nl), Odp (pl),
// Ynt (tr), Res (pt). Optional counters like "Re[2]:" and full-width colons are allowed.
const PREFIX =
  /^\s*(?:re|fwd?|aw|wg|sv|vs|tr|rv|enc|antw|odp|ynt|res)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]/i;

/** Subject with reply/forward prefixes removed, lowercased and whitespace-collapsed. */
export function normalizeSubject(subject: string): string {
  let rest = subject.trim();
  for (let match = PREFIX.exec(rest); match; match = PREFIX.exec(rest)) {
    rest = rest.slice(match[0].length).trim();
  }
  return rest.replace(/\s+/g, " ").toLowerCase();
}

export interface ThreadCandidate {
  threadId: string;
  /** `normalizeSubject()` of the thread's subject. */
  subjectKey: string;
  /** Every address that sent or received a message in the thread. */
  participants: string[];
  lastMessageAt: Date;
}

export interface ThreadContext {
  /** Thread ids of already-stored messages, keyed by Message-ID (`<id@host>`). */
  knownMessageIds: ReadonlyMap<string, string>;
  /** Threads in the same mailbox whose subject key equals the message's. */
  candidates: readonly ThreadCandidate[];
  /** The mailbox's own addresses. They appear on every message, so they never count as overlap. */
  selfAddresses: readonly string[];
  /**
   * Thread of a stored message whose reply headers name this message or one of its parents.
   * Mail can arrive child first (a history import runs newest first, Sent before INBOX), and
   * this keeps the grouping the same whatever the order.
   */
  relatedThreadId?: string | null | undefined;
}

export type ThreadDecision =
  | { kind: "headers"; threadId: string }
  | { kind: "subject"; threadId: string }
  | { kind: "new"; subjectKey: string };

const SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Spec "Grouping messages into threads": reply headers, then subject + participants, else new. */
export function decideThread(message: ParsedMessage, context: ThreadContext): ThreadDecision {
  // In-Reply-To names the direct parent; References is oldest first, so walk it newest first.
  const replyIds = [message.inReplyTo, ...message.references.toReversed()].filter(
    (id): id is string => id !== null,
  );
  for (const id of replyIds) {
    const threadId = context.knownMessageIds.get(id);
    if (threadId !== undefined) return { kind: "headers", threadId };
  }
  if (context.relatedThreadId) return { kind: "headers", threadId: context.relatedThreadId };

  const subjectKey = normalizeSubject(message.subject);
  // A reply whose parent we never saw starts a thread; subject matching is only for mail
  // that carries no reply headers at all. An empty subject would match unrelated mail.
  if (replyIds.length > 0 || subjectKey === "" || message.sentAt === null) {
    return { kind: "new", subjectKey };
  }

  const self = new Set(context.selfAddresses.map((a) => a.toLowerCase()));
  const people = new Set(participants(message).filter((a) => !self.has(a)));
  const sentAt = message.sentAt.getTime();
  const match = context.candidates
    .filter(
      (thread) =>
        thread.subjectKey === subjectKey &&
        Math.abs(sentAt - thread.lastMessageAt.getTime()) <= SUBJECT_WINDOW_MS &&
        thread.participants.some((a) => people.has(a.toLowerCase())),
    )
    .toSorted((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())[0];

  return match ? { kind: "subject", threadId: match.threadId } : { kind: "new", subjectKey };
}

/** Lowercased addresses on From, To, Cc and Reply-To. */
export function participants(message: ParsedMessage): string[] {
  const all = [message.from, ...message.to, ...message.cc, ...message.replyTo];
  return [...new Set(all.filter((a): a is Address => a !== null).map((a) => a.address))];
}

export { addedRecipients } from "./display.ts";

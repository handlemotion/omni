// Builds the triage input from a thread's stored messages. The queue consumer and the fixture
// tests both go through here, so recorded Jev answers are keyed to exactly what production sends.
import type { TriageInput } from "./types.ts";

/** One stored message, as `messages` holds it. */
export interface ThreadMessage {
  fromName: string | null;
  fromAddress: string;
  subject: string;
  /** `clean_text`: the body with quoted replies and signatures stripped. */
  cleanText: string;
}

/**
 * `messages` oldest first; the last one is the message being triaged. `isUs` says whether an
 * address belongs to one of the org's own mailboxes (compare case-insensitively).
 */
export function triageInputFor(
  messages: readonly ThreadMessage[],
  isUs: (address: string) => boolean,
): TriageInput {
  const latest = messages.at(-1);
  if (!latest) throw new Error("triageInputFor needs at least one message");
  const earlier = messages.slice(0, -1);
  return {
    from: { name: latest.fromName, address: latest.fromAddress },
    subject: latest.subject,
    latestText: latest.cleanText,
    latestFromUs: isUs(latest.fromAddress),
    messageCount: messages.length,
    repliedBefore: earlier.some((m) => isUs(m.fromAddress)),
    earlierMessages: earlier.map((m) => ({
      from: m.fromAddress,
      fromUs: isUs(m.fromAddress),
      text: m.cleanText,
    })),
  };
}

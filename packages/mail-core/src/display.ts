// How a stored thread reads in chat mode: bubble or card per message, and who joined mid-thread.
// No dependencies, so the Worker imports it as `@omni/mail-core/display` without the parser.

export interface DisplayAddress {
  name: string | null;
  address: string;
}

/** The fields of a stored message (`messages` row) that participants are read from. */
export interface DisplayMessage {
  fromAddress: string;
  to: DisplayAddress[];
  cc: DisplayAddress[];
}

/** Over this many words of clean text, a message renders as a card (spec: "about 120 words"). */
export const CARD_MIN_WORDS = 121;

/**
 * `"card"` for long messages, `"bubble"` otherwise. The spec's "tables make it a card" rule needs
 * the HTML, so it is not applied here.
 */
export function messageDisplay(cleanText: string): "bubble" | "card" {
  let words = 0;
  for (const _ of cleanText.matchAll(/\S+/g)) {
    if (++words >= CARD_MIN_WORDS) return "card";
  }
  return "bubble";
}

/**
 * For each message (oldest first), the To/Cc addresses no earlier message had in From, To or
 * Cc, compared case-insensitively: the "Ana added Luis" line. The first message adds nobody,
 * nor does anyone add the mailbox itself or the message's own sender.
 */
export function addedParticipants(
  messages: readonly DisplayMessage[],
  selfAddress: string,
): DisplayAddress[][] {
  const seen = new Set<string>([selfAddress.toLowerCase()]);
  return messages.map((message, index) => {
    const sender = message.fromAddress.toLowerCase();
    const recipients = [...message.to, ...message.cc];
    const added: DisplayAddress[] = [];
    for (const recipient of recipients) {
      const key = recipient.address.toLowerCase();
      // Marked seen right away, so an address on both To and Cc is added once.
      if (index > 0 && key !== sender && !seen.has(key)) added.push(recipient);
      seen.add(key);
    }
    seen.add(sender);
    return added;
  });
}

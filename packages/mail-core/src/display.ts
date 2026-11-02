// How a thread renders as chat. Pure and free of mailparser, so the Worker can import it
// (`@omni/mail-core/display`) to shape the thread for web and iOS alike.

/** Spec "Rendering rules": over about 120 words renders as a card. */
export const CARD_MIN_WORDS = 121;

/** `bubble` for a short message, `card` for a long one, judged on the stripped text. */
export function messageDisplay(cleanText: string): "bubble" | "card" {
  let words = 0;
  for (const _ of cleanText.matchAll(/\S+/g)) {
    if (++words >= CARD_MIN_WORDS) return "card";
  }
  return "bubble";
}

/**
 * For each message, oldest first, the To/Cc people no earlier message in the thread included
 * ("Ana added Luis"). The first message adds nobody: everyone on it started the thread.
 */
export function addedParticipants<A extends { address: string }>(
  messages: readonly { fromAddress: string; to: readonly A[]; cc: readonly A[] }[],
): A[][] {
  const seen: string[] = [];
  return messages.map((message, index) => {
    const from = { address: message.fromAddress };
    const added = index === 0 ? [] : addedRecipients({ ...message, from }, seen);
    seen.push(...[from, ...message.to, ...message.cc].map((a) => a.address));
    return added;
  });
}

/**
 * People on To/Cc that no earlier message in the thread included, for the "Ana added Luis"
 * system line. `earlier` is every address already seen in the thread. Works on parsed mail and
 * on stored rows alike; addresses compare case-insensitively.
 */
export function addedRecipients<A extends { address: string }>(
  message: { from: { address: string } | null; to: readonly A[]; cc: readonly A[] },
  earlier: Iterable<string>,
): A[] {
  const seen = new Set([...earlier].map((a) => a.toLowerCase()));
  if (message.from) seen.add(message.from.address.toLowerCase());
  return [...message.to, ...message.cc].filter((a) => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

import type { Message, Thread } from "./types.ts";
import { messageHtmlUrl } from "./urls.ts";

/**
 * Whether a message opens as the sender's HTML rather than its text: it has no text of its own,
 * or it is outside mail whose images carry it.
 */
export function opensFull(message: Message) {
  if (!message.hasHtml) return false;
  if (!message.cleanText.trim()) return true;
  return !message.fromTeam && (message.remoteImageCount > 0 || /\[image: /.test(message.cleanText));
}

const WARM_NEWEST = 3;

const warmed = new Set<string>();

/**
 * Loads the HTML of a thread's newest full messages into the browser's HTTP cache (the Worker
 * sends it `private, max-age=3600`), so their frames paint from the cache when the thread opens
 * instead of waiting on a round trip after the thread itself arrives. Each URL is fetched once.
 */
export function warmThreadHtml(thread: Thread) {
  for (const message of thread.messages.slice(-WARM_NEWEST)) {
    if (!opensFull(message)) continue;
    const url = messageHtmlUrl(thread.id, message.id);
    if (warmed.has(url)) continue;
    warmed.add(url);
    const forget = () => void warmed.delete(url);
    fetch(url, { credentials: "same-origin", priority: "low" })
      .then(async (response) => {
        if (!response.ok) return forget();
        await response.arrayBuffer();
      })
      .catch(forget);
  }
}

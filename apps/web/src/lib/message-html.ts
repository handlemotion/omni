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

/** The sandbox of a message's frame: scripts off, same-origin (see `FullMessage`). */
export const MESSAGE_FRAME_SANDBOX =
  "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

const WARM_NEWEST = 3;

const warmed = new Set<string>();

function loadedStatus(frame: HTMLIFrameElement) {
  try {
    const [entry] = frame.contentWindow?.performance.getEntriesByType("navigation") ?? [];
    return (entry as PerformanceNavigationTiming | undefined)?.responseStatus ?? 0;
  } catch {
    return 0;
  }
}

// WARNING: Chrome caches a frame's documents apart from fetch(), so only a frame warms a frame.
function warmInFrame(url: string, forget: () => void) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", MESSAGE_FRAME_SANDBOX);
  frame.addEventListener(
    "load",
    () => {
      if (loadedStatus(frame) !== 200) forget();
      frame.remove();
    },
    { once: true },
  );
  frame.src = url;
  document.body.append(frame);
}

/**
 * Loads the HTML of a thread's newest full messages into the browser's HTTP cache, so their
 * frames paint from the cache when the thread opens instead of waiting on a round trip after the
 * thread itself arrives. Each URL is loaded once.
 */
export function warmThreadHtml(thread: Thread) {
  for (const message of thread.messages.slice(-WARM_NEWEST)) {
    if (!opensFull(message)) continue;
    const url = messageHtmlUrl(thread.id, message.id);
    if (warmed.has(url)) continue;
    warmed.add(url);
    warmInFrame(url, () => void warmed.delete(url));
  }
}

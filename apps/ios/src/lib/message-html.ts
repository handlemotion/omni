import type { Message } from "@omni/client";

/**
 * Whether a message opens as the sender's HTML rather than its text, as on the web: it has no
 * text of its own, or it is outside mail whose images carry it.
 */
export function opensFull(message: Message) {
  if (!message.hasHtml) return false;
  if (!message.cleanText.trim()) return true;
  return !message.fromTeam && (message.remoteImageCount > 0 || /\[image: /.test(message.cleanText));
}

const BLOCKED_SRC_ATTR = "data-omni-src";

/** The newest messages whose HTML is fetched before a thread opens. */
export const WARM_NEWEST = 3;

const FRAME_DEFAULTS =
  'html{padding:16px;-webkit-text-size-adjust:100%}body{margin:0;display:flow-root;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}';

/**
 * The Worker's sanitized HTML fragment as a page of its own, laid out like the web's frame: its
 * remote images swapped in through the image proxy (the web does that as the frame loads), the
 * Worker's CSP repeated as a meta tag since the page loads from a string, and the web frame's
 * padding and font.
 */
export function messageDocument(html: string) {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${FRAME_DEFAULTS}</style>`,
    "</head><body>",
    html.replaceAll(` ${BLOCKED_SRC_ATTR}="`, ' src="'),
    "</body></html>",
  ].join("");
}

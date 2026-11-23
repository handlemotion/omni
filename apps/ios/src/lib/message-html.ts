import { BLOCKED_SRC_ATTR } from "@omni/mail-core/blocked-src";

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

// URLs the UI puts straight into the DOM (iframe `src`, download links), built from the typed
// client so a renamed route is a type error here. All are same-origin and use the session cookie.
import { api } from "./api.ts";

/**
 * A message's sanitized HTML. Render it in
 * `<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" src=…>`:
 * scripts stay off, and `allow-same-origin` lets its images (the Worker routes remote ones
 * through the image proxy and serves `cid:` ones) send the session cookie. Without it every
 * image is refused. Never add `allow-scripts`.
 */
export function messageHtmlUrl(threadId: string, messageId: string) {
  return api.threads[":id"].messages[":messageId"].html
    .$url({ param: { id: threadId, messageId } })
    .toString();
}

/** An attachment: images display inline, everything else downloads. */
export function attachmentUrl(threadId: string, attachmentId: string) {
  return api.threads[":id"].attachments[":attachmentId"]
    .$url({ param: { id: threadId, attachmentId } })
    .toString();
}

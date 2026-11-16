import { useEffect, useRef, useState } from "react";
import { messageHtmlUrl } from "@/lib/urls.ts";

/** Enough fits for images and fonts arriving late; few enough to stop a viewport-unit loop. */
const MAX_REFITS = 12;

/** Where the mail service parks a blocked remote image's proxied URL (`BLOCKED_SRC_ATTR`). */
const BLOCKED_SRC = "data-omni-src";

/**
 * Takes away the browser's default 8px body margin, so a sender's full-width layout fills the
 * frame and its rounded corners clip it. First in the head, so the sender's own styles still win.
 */
function dropDefaultMargin(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!doc?.head) return;
  const style = doc.createElement("style");
  style.textContent = "body{margin:0}";
  doc.head.prepend(style);
}

/** Puts each blocked remote image's proxied URL back in `src`, so it loads. */
function loadRemoteImages(frame: HTMLIFrameElement | null) {
  for (const img of frame?.contentDocument?.querySelectorAll(`img[${BLOCKED_SRC}]`) ?? []) {
    img.setAttribute("src", img.getAttribute(BLOCKED_SRC) ?? "");
    img.removeAttribute(BLOCKED_SRC);
  }
}

/**
 * A message's sanitized HTML, as the sender laid it out. Sandboxed with scripts off; same-origin
 * so its images can send the session cookie (see `messageHtmlUrl`), which also lets this page
 * read the document's height and swap in its remote images, through the image proxy, as it opens
 * (ADR 0041). The frame grows to fit its content, so the conversation scrolls as one page instead
 * of a box inside a box.
 */
export function FullMessage(props: {
  threadId: string;
  messageId: string;
  /** On the page (a single email), not inside a card: the frame is the message's own island. */
  flat?: boolean | undefined;
}) {
  const { threadId, messageId } = props;
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    let refits = 0;
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      // Mail sized in viewport units (`height: 100vh`) grows with the frame on every fit, so
      // refitting is bounded: past the cap the frame keeps its height and scrolls inside.
      if (++refits > MAX_REFITS) return observer?.disconnect();
      // Margins are part of the page, not the body box: measure the root's scroll height.
      setHeight(doc.documentElement.scrollHeight);
    };
    const onLoad = () => {
      loadRemoteImages(frame);
      dropDefaultMargin(frame);
      refits = 0;
      fit();
      // Images and web fonts land after `load` for lazy content: refit as the body resizes.
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(fit);
        observer.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, []);

  return (
    <iframe
      ref={ref}
      title="Full message"
      src={messageHtmlUrl(threadId, messageId)}
      // Never add `allow-scripts`: with `allow-same-origin` it would let mail run as the app.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      // Mail that never loads still leaves room to see it is coming.
      style={{ height: height ?? 160 }}
      // Rounded like a card on the page; inside a card, the card's own corners clip it.
      className={`block w-full bg-background ${props.flat ? "rounded-xl" : ""}`}
    />
  );
}

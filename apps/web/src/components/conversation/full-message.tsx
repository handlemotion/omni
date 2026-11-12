import { useEffect, useRef, useState } from "react";
import { messageHtmlUrl } from "@/lib/urls.ts";

/** Enough fits for images and fonts arriving late; few enough to stop a viewport-unit loop. */
const MAX_REFITS = 12;

/**
 * A message's sanitized HTML, as the sender laid it out. Sandboxed with scripts off; same-origin
 * so its images can send the session cookie (see `messageHtmlUrl`), which also lets this page
 * read the document's height. The frame grows to fit its content, so the conversation scrolls as
 * one page instead of a box inside a box.
 */
export function FullMessage({ threadId, messageId }: { threadId: string; messageId: string }) {
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
      className="block w-full bg-background"
    />
  );
}

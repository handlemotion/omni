import { useEffect, useRef, useState } from "react";
import { routeFrameContextMenu } from "@/components/ui/context-menu";
import { messageHtmlUrl } from "@/lib/urls.ts";

const MAX_REFITS = 12;

const BLOCKED_SRC = "data-omni-src";

const FRAME_DEFAULTS =
  'html{padding:16px}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}';

function applyFrameDefaults(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!doc?.head) return;
  const style = doc.createElement("style");
  style.textContent = FRAME_DEFAULTS;
  doc.head.prepend(style);
}

function loadRemoteImages(frame: HTMLIFrameElement | null) {
  for (const img of frame?.contentDocument?.querySelectorAll(`img[${BLOCKED_SRC}]`) ?? []) {
    img.setAttribute("src", img.getAttribute(BLOCKED_SRC) ?? "");
    img.removeAttribute(BLOCKED_SRC);
  }
}

/**
 * A message's sanitized HTML, as the sender laid it out. Sandboxed with scripts off; same-origin
 * so its images can send the session cookie (see `messageHtmlUrl`), which also lets this page
 * read the document's height and swap in its remote images, through the image proxy, as it opens.
 * The frame grows to fit its content, so the conversation scrolls as one page instead
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
    let unroute = () => {};
    let refits = 0;
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      if (++refits > MAX_REFITS) return observer?.disconnect();
      setHeight(doc.documentElement.scrollHeight);
    };
    const onLoad = () => {
      loadRemoteImages(frame);
      applyFrameDefaults(frame);
      unroute();
      unroute = routeFrameContextMenu(frame);
      refits = 0;
      fit();
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
      unroute();
    };
  }, []);

  return (
    <iframe
      ref={ref}
      title="Full message"
      src={messageHtmlUrl(threadId, messageId)}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height: height ?? 160 }}
      className={`block w-full bg-background ${props.flat ? "rounded-xl" : ""}`}
    />
  );
}

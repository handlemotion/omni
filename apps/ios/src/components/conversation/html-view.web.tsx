import { useEffect, useRef, useState } from "react";
import { messageDocument } from "@/lib/message-html.ts";

const MAX_REFITS = 12;

/**
 * Expo's web target (screenshots and checks only): the same page in a sandboxed frame with scripts
 * off, growing to fit its content as the web app's frame does.
 */
export function HtmlView({ html }: { html: string; baseUrl: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let refits = 0;
    let observer: ResizeObserver | undefined;
    const fit = () => {
      const root = frame.contentDocument?.documentElement;
      if (root && ++refits <= MAX_REFITS) setHeight(root.scrollHeight);
    };
    const onLoad = () => {
      refits = 0;
      fit();
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body) (observer = new ResizeObserver(fit)).observe(body);
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
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={messageDocument(html)}
      style={{ border: 0, display: "block", width: "100%", height }}
    />
  );
}

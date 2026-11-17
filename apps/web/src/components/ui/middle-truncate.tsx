import { clearCache, measureNaturalWidth, prepare } from "@chenglou/pretext";
import { cn } from "cn";
import { useLayoutEffect, useRef, useState } from "react";

const ELLIPSIS = "…";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const fontsReady =
  typeof document === "undefined" ? Promise.resolve() : document.fonts.ready.then(clearCache);

function cutToFit(text: string, maxWidth: number, font: string, letterSpacing: number) {
  const width = (s: string) => measureNaturalWidth(prepare(s, font, { letterSpacing }));
  if (width(text) <= maxWidth) return text;
  const parts = Array.from(graphemes.segment(text), (g) => g.segment);
  const cut = (kept: number) =>
    parts
      .slice(0, Math.ceil(kept / 2))
      .join("")
      .trimEnd() +
    ELLIPSIS +
    parts
      .slice(parts.length - Math.floor(kept / 2))
      .join("")
      .trimStart();
  let lo = 0;
  let hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(cut(mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/**
 * A single line that truncates in its middle, refitting as its box resizes. Give it a width
 * that doesn't follow its content (a `min-w-0 flex-1` parent). Screen readers get the whole text.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const fit = () => {
      if (!live) return;
      const style = getComputedStyle(el);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
      setShown(cutToFit(text, el.clientWidth, font, letterSpacing));
    };
    fit();
    void fontsReady.then(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [text]);

  return (
    <span ref={ref} className={cn("block overflow-hidden whitespace-nowrap", className)}>
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

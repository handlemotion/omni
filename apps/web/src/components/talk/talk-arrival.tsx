import { useEffect, useRef, useState } from "react";
import { onTalkMessage } from "@/lib/realtime.ts";
import { talkWindow, useTalkWindow } from "@/lib/talk-window.ts";

const SHOWN_MS = 5_000;
const WIDTH = 240;
const GUTTER = 12;
const TIP = 20;

interface Arrival {
  memberId: string;
  preview: string;
  messageId: string;
  top: number;
  right: number;
}

function placeUnder(memberId: string) {
  const face =
    document.querySelector(`[data-talk-face="${CSS.escape(memberId)}"]`) ??
    document.querySelector("[data-talk-everyone]");
  const box = face?.getBoundingClientRect();
  if (!box) return null;
  const centre = box.left + box.width / 2;
  return { top: box.bottom + 8, right: Math.max(window.innerWidth - centre - TIP, GUTTER) };
}

/**
 * A teammate's note that arrives while no Talk window is open floats in as a bare blue bubble
 * under their face, its tail pointing at them, for a few seconds; pressing it opens the thread.
 */
export function TalkArrival(props: { meId: string }) {
  const open = useTalkWindow();
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideLater = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArrival(null), SHOWN_MS);
  };
  useEffect(
    () =>
      onTalkMessage((event) => {
        if (event.fromMemberId === props.meId || talkWindow.get()) return;
        const at = placeUnder(event.fromMemberId);
        if (!at) return;
        setArrival({
          ...at,
          memberId: event.fromMemberId,
          preview: event.preview,
          messageId: event.messageId,
        });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setArrival(null), SHOWN_MS);
      }),
    [props.meId],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!arrival || open) return null;
  return (
    <button
      key={arrival.messageId}
      type="button"
      aria-label={`New note: ${arrival.preview}`}
      data-talk-arrival={arrival.memberId}
      onPointerEnter={() => clearTimeout(timer.current)}
      onPointerLeave={hideLater}
      onClick={() => {
        setArrival(null);
        talkWindow.open(arrival.memberId);
      }}
      style={{ top: arrival.top, right: arrival.right, maxWidth: WIDTH }}
      className="fixed z-40 origin-top-right cursor-pointer rounded-xl bg-primary px-3 py-1.5 text-start text-sm/5 text-primary-foreground shadow-overlay outline-hidden animate-in fade-in zoom-in-90 slide-in-from-top-1 duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring motion-reduce:animate-none"
    >
      <span
        aria-hidden
        style={{ right: TIP - 5 }}
        className="absolute -top-1 size-2.5 rotate-45 rounded-[2px] bg-primary"
      />
      <span className="line-clamp-2 break-words">{arrival.preview}</span>
    </button>
  );
}

// The chat input every chat in the app writes in: the AI composer from handlemotion/dorks
// (`ChatComposer.tsx`, the AI Elements prompt input) on Omni's primitives. One row that grows
// into a box once the text wraps (up to 40% of the viewport, then it scrolls), an optional button
// at the bottom-left corner, Send at the bottom-right, Enter to send, Shift+Enter for a new line,
// and an optional banner on top (the reply being answered). Used by a shared inbox's hidden notes
// and by a file's comments.
import {
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconArrowUp, IconReply, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { replyLabel, type Reply } from "@/lib/reply.ts";

/** Whether the text runs past one line; re-measured as it changes and as the box resizes. */
function useWraps(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  const [wraps, setWraps] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const content =
        el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setWraps(content > parseFloat(style.lineHeight) * 1.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, text]);
  return wraps;
}

export function ChatBox(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  boxRef?: RefObject<HTMLDivElement | null>;
  value: string;
  onChange: (text: string, caret: number) => void;
  onSelect?: (text: string, caret: number) => void;
  /** Runs first; a handler that calls `preventDefault` keeps Enter from sending. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  label: string;
  placeholder: string;
  /** Send's label and tooltip. */
  sendLabel: string;
  /** False while there is nothing to send, or while the last send is on its way. */
  canSend: boolean;
  onSend: () => void;
  /** Above the text, 8px inside the box: the reply being answered. */
  banner?: ReactNode;
  /** The bottom-left button (Mention, for notes). */
  leading?: ReactNode;
  /** Dotted with no fill: what it adds is hidden from someone (a shared inbox's notes). */
  dashed?: boolean;
  /**
   * One 32px row, as tall as a menu row: for a box inside a list (a comment thread), not under a
   * whole conversation.
   */
  compact?: boolean;
  /** For a picker the box drives (the mention list). */
  textareaProps?: { "aria-expanded"?: boolean; "aria-haspopup"?: "listbox" };
}) {
  // One row until the text wraps; then the text takes the box and the buttons sit under it.
  const stacked = useWraps(props.textareaRef, props.value);
  const lead = props.leading !== undefined;
  const compact = props.compact === true;
  return (
    // 12px corners: a banner 8px inside keeps 4px, concentric.
    <div
      ref={props.boxRef}
      className={`relative flex flex-col border focus-within:border-ring/70 ${
        compact ? "rounded-[8px]" : "rounded-[12px]"
      } ${
        props.dashed ? "border-dashed border-muted-foreground/40" : "border-input bg-background"
      }`}
    >
      {props.banner && <div className="px-2 pt-2">{props.banner}</div>}
      <Textarea
        ref={props.textareaRef}
        plain
        aria-label={props.label}
        placeholder={props.placeholder}
        rows={1}
        value={props.value}
        {...props.textareaProps}
        onChange={(event) => props.onChange(event.target.value, event.target.selectionStart)}
        onSelect={(event) =>
          props.onSelect?.(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (props.canSend) props.onSend();
          }
        }}
        // A 44px row: 12px above and below a 20px line. The text ends 42px in (past Send, its
        // 8px edge and 6px more) and, with a leading button, starts 42px in too. Stacked, the
        // bottom inset makes room for the button row (16px gap, 28px button, 8px edge).
        // Compact, a 32px row: 6px above and below the line, Send 20px with 6px edges, the text
        // 10px in and ending 32px in; stacked, 10px gap over Send.
        className={`max-h-[40vh] min-h-0 resize-none text-sm/5 sm:text-sm/5 ${
          compact
            ? `ps-2.5 pe-8 py-1.5 sm:ps-2.5 sm:pe-8 sm:py-1.5 ${stacked ? "pb-9 sm:pb-9" : ""}`
            : `pe-[42px] py-3 sm:pe-[42px] sm:py-3 ${
                lead ? "ps-[42px] sm:ps-[42px]" : "ps-3 sm:ps-3"
              } ${stacked ? "pb-13 sm:pb-13" : ""}`
        }`}
      />
      {/* The buttons keep one spot, 8px from the bottom corners, one row or stacked. */}
      {lead && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1">{props.leading}</div>
      )}
      <div className={`absolute ${compact ? "right-1.5 bottom-1.5" : "right-2 bottom-2"}`}>
        <TooltipTrigger delay={400}>
          <Button
            size={compact ? "sq-2xs" : "sq-sm"}
            aria-label={props.sendLabel}
            isDisabled={!props.canSend}
            onPress={props.onSend}
          >
            <IconArrowUp />
          </Button>
          <Tooltip>{props.sendLabel} ↵</Tooltip>
        </TooltipTrigger>
      </div>
    </div>
  );
}

/** The reply as one quiet line: who wrote it and the quoted words, cut to one line. */
export function ReplyLine({ reply, className = "" }: { reply: Reply; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <IconReply aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {reply.from}: “{replyLabel(reply)}”
      </span>
    </span>
  );
}

/** The reply being answered, on top of the box, with a way to drop it. */
export function ReplyBanner({ reply, onClear }: { reply: Reply; onClear: () => void }) {
  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-1 rounded-sm bg-accent ps-2.5 pe-1 text-[13px] text-muted-foreground">
      <ReplyLine reply={reply} className="flex-1" />
      <TooltipTrigger delay={400}>
        <Button
          intent="ghost"
          size="sq-xs"
          aria-label="Remove reply"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onPress={onClear}
        >
          <IconX />
        </Button>
        <Tooltip>Remove reply</Tooltip>
      </TooltipTrigger>
    </div>
  );
}

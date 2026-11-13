// Selecting text in a message or note opens a small box on the selection: the passage, quoted,
// and a field for the answer. Enter (or the arrow) puts the passage in a hidden reply, with
// anything typed as its text; Cmd/Ctrl+Enter sends it to the team right away. Copied from
// handlemotion/dorks (`Reply.tsx`, `SelectionReply`) onto Omni's primitives. The passage stays
// highlighted (CSS Custom Highlight) while the box is open, since focusing the field clears the
// real selection.
import { useEffect, useRef, useState } from "react";
import { IconArrowUp } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Input, InputGroup } from "@/components/ui/input";
import { AriaPopover as Popover } from "@/components/ui/aria-popover";
import { appToast } from "@/components/ui/toast";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useAddNote } from "@/hooks/use-notes.ts";
import { quoteText, withReply, type Reply } from "@/lib/reply.ts";
import { useComposerState } from "./composer-state.tsx";

/** Marks an element whose selected text can be replied to; its value names the author. */
export const REPLY_SOURCE = "data-reply-from";
const HIGHLIGHT = "omni-reply";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type Target = { range: Range; reply: Reply; rect: DOMRect };

export function SelectionReply({ threadId }: { threadId: string }) {
  const composer = useComposerState();
  const addNote = useAddNote();
  const [target, setTarget] = useState<Target>();
  const [text, setText] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const enabled = composer.chat;

  useEffect(() => {
    if (!enabled) return;
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // The selection settles after pointerup (a double click selects the word then).
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const source = (node: Node) =>
          (node instanceof Element ? node : node.parentElement)?.closest(`[${REPLY_SOURCE}]`);
        const start = source(range.startContainer);
        // One message at a time: a passage across two has no single author to reply to.
        if (!start || start !== source(range.endContainer)) return;
        const quoted = quoteText(selection.toString());
        if (!quoted) return;
        // Anchored on the selection's first line, so a long passage keeps the box on screen.
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        setText("");
        setTarget({
          range: range.cloneRange(),
          rect,
          reply: { from: start.getAttribute(REPLY_SOURCE) ?? "", text: quoted },
        });
      });
    };
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, [enabled]);

  useEffect(() => {
    const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!target || !highlights || typeof Highlight === "undefined") return;
    highlights.set(HIGHLIGHT, new Highlight(target.range));
    return () => void highlights.delete(HIGHLIGHT);
  }, [target]);

  if (!enabled || !target) return null;
  const close = () => setTarget(undefined);
  const attach = () => {
    composer.replyInChat(target.reply, text.trim() || undefined);
    window.getSelection()?.removeAllRanges();
    close();
  };
  const send = () => {
    const written = text.trim();
    if (!written) return;
    addNote
      .mutateAsync({ threadId, body: withReply(target.reply, written), mentions: [] })
      .catch((error: Error) => {
        void navigator.clipboard?.writeText(written).catch(() => undefined);
        appToast.error(error.message, { description: "The message is on your clipboard." });
      });
    window.getSelection()?.removeAllRanges();
    close();
  };

  return (
    <>
      <span
        ref={anchor}
        aria-hidden
        className="pointer-events-none fixed"
        style={{
          top: target.rect.top,
          left: target.rect.left,
          width: target.rect.width,
          height: target.rect.height,
        }}
      />
      <Popover
        triggerRef={anchor}
        isOpen
        onOpenChange={(open) => !open && close()}
        placement="top start"
        offset={6}
        className="w-80 max-w-80"
      >
        <div className="flex flex-col gap-3 p-3">
          <blockquote className="line-clamp-3 border-s-2 border-border ps-2.5 text-sm/5 text-muted-foreground">
            {target.reply.text}
          </blockquote>
          <InputGroup>
            <Input
              autoFocus
              aria-label={`Hidden reply to ${target.reply.from}`}
              placeholder={`Hidden reply to ${target.reply.from}`}
              autoComplete="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // Enter that confirms an IME candidate is part of typing, not a reply.
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (event.metaKey || event.ctrlKey) send();
                else attach();
              }}
            />
            <TooltipTrigger delay={400}>
              {/* Quiet: it attaches by default, so it is not the blue send. */}
              <Button
                intent="ghost"
                size="inset"
                aria-label="Add to hidden reply"
                className="text-muted-foreground hover:text-foreground"
                onPress={attach}
              >
                <IconArrowUp />
              </Button>
              <Tooltip>{`Enter to add to a hidden reply, ${isMac ? "⌘" : "Ctrl+"}Enter to send`}</Tooltip>
            </TooltipTrigger>
          </InputGroup>
        </div>
      </Popover>
    </>
  );
}

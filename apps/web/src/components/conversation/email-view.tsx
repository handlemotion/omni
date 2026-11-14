// How the open thread reads: as the conversation (messages, notes and activity, with the team's
// chat under them) or as its emails, one at a time, paged with the chevrons at the bottom left.
import { useState, type ReactNode } from "react";
import { IconChevronDown, IconChevronUp, IconMail } from "@/components/icons/central";
import { IconBubble } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { Thread } from "@/lib/types.ts";

export type ReaderView = "conversation" | "email";

/**
 * The view and the email shown, for this thread only: opening another starts over at its latest
 * email, in the email view when it is a single email.
 */
export function useReaderView(threadId: string, thread: Thread | undefined, single: boolean) {
  const [chosen, setChosen] = useState<{ threadId: string; view: ReaderView }>();
  const [at, setAt] = useState<{ threadId: string; id: string }>();
  const messages = thread?.messages ?? [];
  const fallback: ReaderView = single ? "email" : "conversation";
  const view = chosen?.threadId === threadId ? chosen.view : fallback;
  // The one picked with the chevrons while it's still in the thread, else the latest.
  const picked = at?.threadId === threadId ? messages.findIndex((m) => m.id === at.id) : -1;
  const index = picked === -1 ? messages.length - 1 : picked;
  return {
    view,
    setView: (next: ReaderView) => setChosen({ threadId, view: next }),
    index,
    email: messages[index],
    /** What the timeline shows: every message, or the one email paged to. */
    shown: view === "email" ? messages.slice(index, index + 1) : messages,
    /** To the email `step` away: -1 the older one, 1 the newer. */
    move: (step: number) => {
      const next = messages[index + step];
      if (next) setAt({ threadId, id: next.id });
    },
  };
}

/** Older and newer email, at the reading pane's bottom left, across from Reply and Forward. */
export function FloatingPager(props: {
  index: number;
  count: number;
  onMove: (step: number) => void;
}) {
  if (props.count < 2) return null;
  return (
    <div className="pointer-events-none absolute start-5 bottom-full z-20 mb-5 flex gap-1 *:pointer-events-auto">
      <Pager label="Previous email" isDisabled={props.index === 0} onPress={() => props.onMove(-1)}>
        <IconChevronUp />
      </Pager>
      <Pager
        label="Next email"
        isDisabled={props.index === props.count - 1}
        onPress={() => props.onMove(1)}
      >
        <IconChevronDown />
      </Pager>
    </div>
  );
}

function Pager(props: {
  label: string;
  isDisabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={400}>
      {/* Plain glyphs, the toolbar's size: 28px squares that fill only on hover. */}
      <Button
        intent="ghost"
        size="sq-sm-lg"
        aria-label={props.label}
        isDisabled={props.isDisabled}
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

/** Switches between the two views, at the end of the properties rail; always there. */
export function ViewToggle({
  view,
  onChange,
}: {
  view: ReaderView;
  onChange: (next: ReaderView) => void;
}) {
  // One quiet button either way: only its icon and label follow the view, never its fill.
  const email = view === "email";
  return (
    <Button intent="ghost" size="sm" onPress={() => onChange(email ? "conversation" : "email")}>
      {email ? <IconBubble /> : <IconMail />}
      {email ? "Show conversation" : "Show email"}
    </Button>
  );
}

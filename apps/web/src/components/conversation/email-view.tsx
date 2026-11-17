import { useState, type ReactNode } from "react";
import { IconChevronDown, IconChevronUp, IconMail } from "@/components/icons/central";
import { IconBubble } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { Thread } from "@/lib/types.ts";
import { useComposerState } from "../compose/composer-state.tsx";

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
  const picked = at?.threadId === threadId ? messages.findIndex((m) => m.id === at.id) : -1;
  const index = picked === -1 ? messages.length - 1 : picked;
  return {
    view,
    setView: (next: ReaderView) => setChosen({ threadId, view: next }),
    index,
    email: messages[index],
    shown: view === "email" ? messages.slice(index, index + 1) : messages,
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
  const composer = useComposerState();
  const docked = composer.email && composer.mode === "public";
  if (props.count < 2) return null;
  return (
    <div
      className={`pointer-events-none absolute start-5 bottom-full z-20 flex gap-2 *:pointer-events-auto ${docked ? "mb-2.5" : "mb-5"}`}
    >
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
      <Button
        intent="outline"
        size="sq-sm"
        className="shadow-(--shadow-overlay)"
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
  const email = view === "email";
  return (
    <Button intent="ghost" size="sm" onPress={() => onChange(email ? "conversation" : "email")}>
      {email ? <IconBubble /> : <IconMail />}
      {email ? "Show conversation" : "Show email"}
    </Button>
  );
}

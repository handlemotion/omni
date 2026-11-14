// Which composer the open conversation shows, shared by the timeline (each message's menu, a
// selection's reply box) and the composer under it. Hidden is the team's side of a shared inbox:
// internal notes, written like a chat. Public is the email the customer gets: a reply or a
// forward. On a personal thread the email composer stays closed until Reply or Forward opens it;
// on a shared inbox it starts open. Discard closes it on both.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Reply } from "@/lib/reply.ts";

export type ComposerMode = "public" | "hidden";
/** Who a reply goes to: the latest sender, or everyone on the thread outside the team. */
export type ReplyKind = "reply" | "replyAll";

interface ComposerState {
  /** True on a shared inbox: Hidden exists. A personal thread only has Public. */
  chat: boolean;
  mode: ComposerMode;
  setMode: (mode: ComposerMode) => void;
  /** What the next hidden message replies to, shown as a banner in the chat box. */
  reply: Reply | undefined;
  /** Text handed over from a selection's reply box, to start the chat message with. */
  seed: { text: string } | undefined;
  /** Opens Hidden replying to `reply`, with `draft` (typed in the selection's box) as its text. */
  replyInChat: (reply: Reply, draft?: string) => void;
  clearReply: () => void;
  /** The message being forwarded; Public replies when there is none. */
  forwardId: string | undefined;
  forward: (messageId: string) => void;
  stopForward: () => void;
  /** Whether the composer shows: open from the start on a shared inbox, until a discard. */
  open: boolean;
  replyKind: ReplyKind;
  /** Opens the email composer as a reply (to the sender, or to all). */
  openReply: (kind: ReplyKind) => void;
  /** Closes it after a discard, until Reply, Forward or a hidden reply opens it again. */
  close: () => void;
  /** Changes on every close, so the next composer starts empty. */
  generation: number;
}

const Context = createContext<ComposerState | null>(null);

/** One per open conversation (keyed by thread), so nothing carries over to the next one. */
export function ComposerProvider({ chat, children }: { chat: boolean; children: ReactNode }) {
  const [mode, setMode] = useState<ComposerMode>("public");
  const [reply, setReply] = useState<Reply>();
  const [seed, setSeed] = useState<{ text: string }>();
  const [forwardId, setForwardId] = useState<string>();
  // A shared inbox's composer (also its chat) starts open; a personal thread's waits for Reply.
  const [opened, setOpened] = useState(chat);
  // A shared inbox writes to everyone outside the team by default, as it always did.
  const [replyKind, setReplyKind] = useState<ReplyKind>(chat ? "replyAll" : "reply");
  const [generation, setGeneration] = useState(0);
  const value: ComposerState = {
    chat,
    // A personal thread opened in the same reader has no chat.
    mode: chat ? mode : "public",
    setMode,
    reply,
    seed,
    replyInChat: (next, draft) => {
      setReply(next);
      // A new object each time, so the same words handed over twice still arrive.
      if (draft) setSeed({ text: draft });
      setMode("hidden");
      setOpened(true);
    },
    clearReply: () => setReply(undefined),
    forwardId,
    forward: (messageId) => {
      setForwardId(messageId);
      setMode("public");
      setOpened(true);
    },
    stopForward: () => setForwardId(undefined),
    open: opened,
    replyKind,
    openReply: (kind) => {
      setReplyKind(kind);
      setForwardId(undefined);
      setMode("public");
      setOpened(true);
    },
    close: () => {
      setForwardId(undefined);
      setOpened(false);
      setGeneration((n) => n + 1);
    },
    generation,
  };
  return <Context value={value}>{children}</Context>;
}

export function useComposerState() {
  const state = useContext(Context);
  if (!state) throw new Error("useComposerState needs a ComposerProvider");
  return state;
}

// Which composer the open conversation shows, shared by the timeline (each message's menu, a
// selection's reply box) and the composer under it. Hidden is the team's side of a shared inbox:
// internal notes, written like a chat. Public is the email the customer gets: a reply or a
// forward.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Reply } from "@/lib/reply.ts";

export type ComposerMode = "public" | "hidden";

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
}

const Context = createContext<ComposerState | null>(null);

/** One per open conversation (keyed by thread), so nothing carries over to the next one. */
export function ComposerProvider({ chat, children }: { chat: boolean; children: ReactNode }) {
  const [mode, setMode] = useState<ComposerMode>("public");
  const [reply, setReply] = useState<Reply>();
  const [seed, setSeed] = useState<{ text: string }>();
  const [forwardId, setForwardId] = useState<string>();
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
    },
    clearReply: () => setReply(undefined),
    forwardId,
    forward: (messageId) => {
      setForwardId(messageId);
      setMode("public");
    },
    stopForward: () => setForwardId(undefined),
  };
  return <Context value={value}>{children}</Context>;
}

export function useComposerState() {
  const state = useContext(Context);
  if (!state) throw new Error("useComposerState needs a ComposerProvider");
  return state;
}

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { ComposerFile } from "@/hooks/use-compose.ts";
import { draftsQuery } from "@/lib/compose.ts";
import type { Reply } from "@/lib/reply.ts";

export type ComposerMode = "public" | "hidden";
/** An undone send's content, handed to a fresh email composer when its own has gone. */
export interface HandBack {
  mode: "reply" | "forward";
  sourceId: string | undefined;
  text: string;
  to: string[];
  cc: string[];
  bcc: string[];
  files: ComposerFile[];
}

/** Who a reply goes to: the latest sender, or everyone on the thread outside the team. */
export type ReplyKind = "reply" | "replyAll";

interface ComposerState {
  chat: boolean;
  mode: ComposerMode;
  reply: Reply | undefined;
  seed: { text: string } | undefined;
  replyInChat: (reply: Reply, draft?: string) => void;
  clearReply: () => void;
  forwardId: string | undefined;
  forward: (messageId: string) => void;
  stopForward: () => void;
  open: boolean;
  chatOpen: boolean;
  startChat: () => void;
  email: boolean;
  replyKind: ReplyKind;
  replyToId: string | undefined;
  openReply: (kind: ReplyKind, messageId?: string) => void;
  close: () => void;
  sentEmail: () => void;
  showEmail: () => void;
  handBack: (content: HandBack) => boolean;
  takeHandBack: () => HandBack | undefined;
  generation: number;
}

/**
 * A reply or forward asked for from outside the conversation (a list row's menu): the thread's
 * provider takes it once the thread is open, which may be a navigation and a load later.
 */
interface ComposeRequest {
  threadId: string;
  kind: "reply" | "forward";
  /** The message answered or forwarded (a saved draft's); the latest when unset. */
  messageId?: string | undefined;
}
let requested: ComposeRequest | undefined;
const requestListeners = new Set<() => void>();
const subscribeRequests = (listener: () => void) => {
  requestListeners.add(listener);
  return () => requestListeners.delete(listener);
};

/** Opens `threadId`'s email composer, replying to or forwarding its latest message. */
export function requestCompose(request: ComposeRequest) {
  requested = request;
  for (const listener of requestListeners) listener();
}

const Context = createContext<ComposerState | null>(null);

/** One per open conversation (keyed by thread), so nothing carries over to the next one. */
export function ComposerProvider({
  threadId,
  messages,
  chat,
  chatOpen,
  onStartChat,
  children,
}: {
  threadId: string;
  /** The thread's messages: a reply or forward asked for from the list takes the latest. */
  messages: readonly { id: string }[];
  chat: boolean;
  /** A shared inbox's conversation is under way: its hidden composer stays docked. */
  chatOpen: boolean;
  onStartChat: () => void;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<ComposerMode>(chat ? "hidden" : "public");
  const [reply, setReply] = useState<Reply>();
  const [seed, setSeed] = useState<{ text: string }>();
  const [forwardId, setForwardId] = useState<string>();
  const [replyToId, setReplyToId] = useState<string>();
  const [handed, setHanded] = useState<HandBack>();
  const [email, setEmail] = useState(false);
  const [replyKind, setReplyKind] = useState<ReplyKind>(chat ? "replyAll" : "reply");
  const [generation, setGeneration] = useState(0);
  const showing = email && (!chat || mode === "public");
  const showingNow = useRef(showing);
  showingNow.current = showing;
  const resumed = useRef(false);
  const startEmail = () => {
    resumed.current = true;
    setEmail(true);
    setMode("public");
  };
  const latestMessageId = messages.at(-1)?.id;
  const request = useSyncExternalStore(subscribeRequests, () => requested);
  useEffect(() => {
    if (request?.threadId !== threadId) return;
    requested = undefined;
    const messageId = request.messageId ?? latestMessageId;
    if (request.kind === "forward" && !messageId) return;
    setForwardId(request.kind === "forward" ? messageId : undefined);
    if (request.kind === "reply" && request.messageId) setReplyToId(request.messageId);
    startEmail();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- startEmail only sets state
  }, [request, threadId, latestMessageId]);
  const drafts = useQuery(draftsQuery({ threadId }));
  useEffect(() => {
    if (resumed.current || !drafts.data || drafts.isRefetching) return;
    resumed.current = true;
    const saved = drafts.data.find((d) => d.kind === "reply" || d.kind === "forward");
    if (!saved || showingNow.current) return;
    const messageId = saved.sourceMessageId ?? undefined;
    if (saved.kind === "forward") {
      if (!messageId) return;
      setForwardId(messageId);
    } else if (messageId) setReplyToId(messageId);
    startEmail();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, when the thread's drafts load
  }, [drafts.data, drafts.isRefetching]);
  const close = () => {
    setForwardId(undefined);
    setEmail(false);
    if (chat) setMode("hidden");
    setGeneration((n) => n + 1);
  };
  const value: ComposerState = {
    chat,
    mode: chat ? mode : "public",
    reply,
    seed,
    replyInChat: (next, draft) => {
      onStartChat();
      setReply(next);
      if (draft) setSeed({ text: draft });
      setMode("hidden");
    },
    clearReply: () => setReply(undefined),
    forwardId,
    forward: (messageId) => {
      setForwardId(messageId);
      startEmail();
    },
    stopForward: () => setForwardId(undefined),
    open: (chat && chatOpen) || email,
    chatOpen: chat && chatOpen,
    startChat: () => {
      onStartChat();
      setMode("hidden");
    },
    email,
    replyKind,
    replyToId,
    openReply: (kind, messageId) => {
      setReplyKind(kind);
      if (messageId) setReplyToId(messageId);
      setForwardId(undefined);
      startEmail();
    },
    close,
    sentEmail: () => {
      if (chat) setMode("hidden");
      else close();
    },
    showEmail: () => setMode("public"),
    handBack: (content) => {
      if (showingNow.current) return false;
      setHanded(content);
      setForwardId(content.mode === "forward" ? content.sourceId : undefined);
      if (content.mode === "reply" && content.sourceId) setReplyToId(content.sourceId);
      setGeneration((n) => n + 1);
      startEmail();
      return true;
    },
    takeHandBack: () => {
      setHanded(undefined);
      return handed;
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

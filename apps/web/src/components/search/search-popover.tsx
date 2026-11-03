import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Command, defaultFilter } from "cmdk";
import { useGlimm } from "glimm/react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "react-aria-components/Button";
import { Popover } from "react-aria-components/Popover";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconClock,
  IconEmail,
  IconInbox,
  IconSearch,
  IconSettings,
  IconWrite,
} from "@/components/icons/sidebar";
import { Keyboard } from "@/components/ui/keyboard";
import { Loader } from "@/components/ui/loader";
import { useThreads } from "@/hooks/use-mail.ts";
import { searchQuery } from "@/lib/mail-queries.ts";
import { senderLabel } from "@/lib/threads.ts";

// Commands and recent threads in one popover anchored to the title-bar field (Vercel's Find as the
// reference): opening it dims the app and grows the field into the panel, not a centered window.
// "/" or ⌘K opens it from anywhere. Typing filters fuzzily in the browser (cmdk); "Smart search"
// asks the server and shows its results in the main list, at `/search?q=`.

interface Command {
  id: string;
  title: string;
  icon: ReactNode;
  href: string;
}

const COMMANDS: Command[] = [
  { id: "compose", title: "Compose", icon: <IconWrite />, href: "/compose" },
  { id: "inbox", title: "Inbox", icon: <IconInbox />, href: "/inbox" },
  { id: "queue", title: "Queue", icon: <IconClock />, href: "/queue" },
  {
    id: "needs-reply",
    title: "Needs reply",
    icon: <IconBubble />,
    href: "/inbox?lane=needs_reply",
  },
  {
    id: "awaiting-reply",
    title: "Awaiting reply",
    icon: <IconBubbleAnnotation />,
    href: "/inbox?lane=waiting_on_them",
  },
  { id: "all", title: "All mail", icon: <IconEmail />, href: "/all" },
  { id: "settings", title: "Settings", icon: <IconSettings />, href: "/settings" },
];

// The panel grows out of the field: it's anchored to the field's top-right corner, so the closed
// state is the panel clipped to the field's 240×32 rectangle at that corner.
const FIELD = { width: 240, height: 32, radius: 6 };
// Open, the clip reaches 16px past the panel so its shadow (the menu level's ring and short drop)
// shows; the larger radius keeps that clip concentric with the panel's own 8px corners.
const clip = {
  closed: `inset(0px 0px calc(100% - ${FIELD.height}px) calc(100% - ${FIELD.width}px) round ${FIELD.radius}px)`,
  open: "inset(-16px -16px -16px -16px round 24px)",
};
// The strong ease-out (tactile-design), the same curve as `--ease-out`.
const ease = [0.23, 1, 0.32, 1] as const;

type Phase = "closed" | "open" | "closing";

/** The closed state is a 32px field in the title bar. */
export function SearchPopover() {
  const [phase, setPhase] = useState<Phase>("closed");
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Reduced motion: no growing out of the field, the panel crossfades in place instead.
  const reduceMotion = useReducedMotion();
  const open = () => setPhase("open");
  const close = () => setPhase((p) => (p === "closed" ? p : "closing"));

  // "/" (outside text fields) and ⌘K / Ctrl+K open it from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]");
      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !typing)
      ) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isOpen = phase === "open";

  return (
    <>
      <Button
        ref={triggerRef}
        onPress={open}
        aria-label="Search"
        // A button that opens search wears a field's look: a hairline edge on white, no shadow.
        className="flex h-8 w-60 cursor-text items-center gap-2 rounded-lg border-(length:--hairline) border-line bg-background ps-2 pe-1.25 text-sm text-muted-foreground outline-hidden transition-colors duration-150 ease-out hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <IconSearch className="text-muted-foreground" />
        <span className="flex-1 text-start">Search</span>
        <Keyboard>/</Keyboard>
      </Button>
      {phase !== "closed" &&
        createPortal(
          <motion.div
            aria-hidden
            className="fixed inset-0 z-40 bg-foreground/10"
            initial={{ opacity: 0 }}
            animate={{ opacity: isOpen ? 1 : 0 }}
            transition={{ duration: 0.2, ease }}
          />,
          document.body,
        )}
      <Popover
        triggerRef={triggerRef}
        isOpen={phase !== "closed"}
        onOpenChange={(next) => (next ? open() : close())}
        placement="bottom end"
        // Opens over the field itself: its top edge sits where the field's top edge is.
        offset={-FIELD.height}
        className="z-50 outline-hidden"
      >
        <motion.div
          // The menu shadow's 1px ring is the panel's edge: no border.
          className="w-100 overflow-hidden rounded-xl bg-background shadow-(--shadow-menu)"
          initial={reduceMotion ? { clipPath: clip.open, opacity: 0 } : { clipPath: clip.closed }}
          animate={
            reduceMotion
              ? { opacity: isOpen ? 1 : 0 }
              : { clipPath: isOpen ? clip.open : clip.closed }
          }
          transition={{ duration: reduceMotion ? 0.15 : 0.24, ease }}
          onAnimationComplete={() => phase === "closing" && setPhase("closed")}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: isOpen ? 1 : 0 }}
            transition={{ duration: isOpen ? 0.18 : 0.1, delay: isOpen ? 0.06 : 0, ease }}
          >
            <SearchPanel onClose={close} />
          </motion.div>
        </motion.div>
      </Popover>
    </>
  );
}

// Seven 40px rows plus padding: the empty state's commands fill the list exactly, so it never
// changes height while typing; more results scroll.
const LIST_HEIGHT = "h-73";

// Rows match on their keywords (title, sender), not on their value, which is just a unique id.
// Smart search always matches: it searches the server for whatever was typed.
const SMART = "smart-search";
const filter = (value: string, search: string, keywords?: string[]) =>
  value === SMART ? 1 : defaultFilter("", search, keywords);

function SearchPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { sweep } = useGlimm();
  const { threads } = useThreads({ view: "inbox" });
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const query = q.trim();

  const go = (to: () => unknown) => {
    onClose();
    void to();
  };

  // Loads the results first, so the sweep reveals a full list rather than a loading one.
  const smartSearch = async () => {
    if (!query || searching) return;
    setSearching(true);
    try {
      await queryClient.fetchQuery(searchQuery(query));
    } finally {
      setSearching(false);
    }
    // Together: the band slides down under the popover while it closes.
    onClose();
    sweep(() => navigate({ to: "/search", search: { q: query } }));
  };

  return (
    <Command label="Search" loop filter={filter} className="outline-hidden">
      <div className="flex h-11 items-center gap-2.5 border-b-(length:--hairline) border-line ps-4.5 pe-3">
        <IconSearch className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          value={q}
          onValueChange={setQ}
          placeholder="Search mail or jump to…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
        />
        <Keyboard>Esc</Keyboard>
      </div>

      <Command.List className={`${LIST_HEIGHT} overflow-y-auto p-1.5 outline-hidden`}>
        {query && (
          <Command.Group>
            <Row
              value={SMART}
              icon={searching ? <Loader className="size-4" /> : <IconSearch />}
              title={`Smart search for “${query}”`}
              pending={searching}
              onSelect={() => void smartSearch()}
            />
          </Command.Group>
        )}
        <Command.Group>
          {COMMANDS.map((c) => (
            <Row
              key={c.id}
              value={`command:${c.id}`}
              keywords={[c.title]}
              icon={c.icon}
              title={c.title}
              onSelect={() => go(() => router.navigate({ href: c.href }))}
            />
          ))}
          {/* Threads only once there's something to match them against. */}
          {query &&
            threads.map((thread) => {
              const sender = senderLabel(thread);
              return (
                <Row
                  key={thread.id}
                  value={`thread:${thread.id}`}
                  keywords={[thread.subject, sender]}
                  icon={<IconEmail />}
                  title={thread.subject || "(no subject)"}
                  detail={sender}
                  onSelect={() =>
                    go(() => navigate({ to: "/inbox/$threadId", params: { threadId: thread.id } }))
                  }
                />
              );
            })}
        </Command.Group>
      </Command.List>
    </Command>
  );
}

/**
 * Every row is one 40px line, a detail (the sender) beside the title rather than under it, so the
 * list keeps one rhythm. The selected row (keyboard or pointer, cmdk keeps one) gets the accent
 * fill and a foreground icon.
 */
function Row(props: {
  value: string;
  keywords?: string[];
  icon: ReactNode;
  title: string;
  detail?: string;
  pending?: boolean;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={props.value}
      keywords={props.keywords}
      onSelect={props.onSelect}
      className="group flex h-10 cursor-default items-center gap-2.5 rounded-lg px-3 text-sm outline-hidden data-[selected=true]:bg-accent"
    >
      <span className="flex shrink-0 text-muted-foreground group-data-[selected=true]:text-foreground *:size-4">
        {props.icon}
      </span>
      <span className={`min-w-0 truncate text-foreground ${props.pending ? "shimmer" : ""}`}>
        {props.title}
      </span>
      {props.detail && (
        <span className="ms-auto max-w-2/5 shrink-0 truncate text-muted-foreground">
          {props.detail}
        </span>
      )}
    </Command.Item>
  );
}

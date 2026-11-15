import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Command, defaultFilter } from "cmdk";
import { motion, useReducedMotion, type Transition } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "react-aria-components/Button";
import { Dialog } from "react-aria-components/Dialog";
import { Modal, ModalOverlay } from "react-aria-components/Modal";
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
import { useListSweep } from "@/components/inbox/list-sweep";
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
  { id: "later", title: "Later", icon: <IconClock />, href: "/later" },
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

// One box, two sizes: the field itself grows into the panel and shrinks back into the field. Its
// search row is the field closed and the panel's top bar open, so nothing swaps or fades in from
// elsewhere. Sizes are the field (`h-7 w-60 rounded-lg`, `ps-2 pe-0.75 gap-2`, 15px icon) and the
// panel (`w-100 rounded-xl`, a 44px `ps-4.5 pe-3 gap-2.5` bar over the fixed-height list).
// The box is pinned to the field's top-right corner, so it grows left and down.
const SIZE = {
  closed: { width: 240, height: 28, borderRadius: 6 },
  open: { width: 400, height: 338, borderRadius: 8 },
};
// With no field on screen (a collapsed sidebar) the box opens centred, wider: a command bar.
const CENTERED_WIDTH = 600;

/** What search opens holding: the words already searched, and the mailbox they were scoped to. */
export interface SearchSeed {
  q: string;
  mailbox?: string | undefined;
}
/** Whatever search is mounted opens itself; set while it is (the sidebar's). */
let openMounted: ((seed?: SearchSeed) => void) | undefined;
/**
 * Opens search from a control elsewhere (the list's search icon), as `/` does; with a `seed`, to
 * edit that search (an empty result's Edit search).
 */
export const openSearch = (seed?: SearchSeed) => openMounted?.(seed);
const BAR = {
  closed: { height: 26, paddingInlineStart: 8, paddingInlineEnd: 3, columnGap: 8 },
  open: { height: 44, paddingInlineStart: 18, paddingInlineEnd: 12, columnGap: 10 },
};
const ICON = { closed: { width: 15, height: 15 }, open: { width: 16, height: 16 } };
// The strong ease-out (tactile-design), the same curve as `--ease-out`.
const ease = [0.23, 1, 0.32, 1] as const;

type Phase = "closed" | "open" | "closing";
type Anchor = { top: number; left?: number; right?: number };

/**
 * The closed state is the 28px field. `side="end"` (a title bar's end) pins the box to the field's
 * top-right corner, growing left and down; `side="start"` (the sidebar) pins it to the top-left,
 * growing right, and the field fills its row.
 */
export function SearchPopover({ side = "end" }: { side?: "start" | "end" }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [anchor, setAnchor] = useState<Anchor>({ top: 0, right: 0 });
  // The field's own width: the closed box matches it, so the box grows out of the field.
  const [fieldWidth, setFieldWidth] = useState(SIZE.closed.width);
  const [openWidth, setOpenWidth] = useState(SIZE.open.width);
  const [seed, setSeed] = useState<SearchSeed | undefined>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Reduced motion: no growing; the box takes its open size at once and crossfades.
  const reduceMotion = useReducedMotion();
  const open = (next?: SearchSeed) => {
    setSeed(next);
    const rect = triggerRef.current?.getBoundingClientRect();
    // The field can be out of view (a collapsed sidebar slides off screen; a hidden column has
    // no size) while `/` and ⌘K still open search: the box then opens centred near the
    // window's top instead.
    if (!rect || rect.width === 0 || rect.right <= 0 || rect.left >= window.innerWidth) {
      const width = Math.min(CENTERED_WIDTH, window.innerWidth - 32);
      setOpenWidth(width);
      setFieldWidth(width);
      setAnchor({ top: 64, left: (window.innerWidth - width) / 2 });
    } else {
      setOpenWidth(SIZE.open.width);
      setFieldWidth(rect.width);
      setAnchor(
        side === "start"
          ? { top: rect.top, left: rect.left }
          : { top: rect.top, right: window.innerWidth - rect.right },
      );
    }
    setPhase("open");
  };
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
    openMounted = open;
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (openMounted === open) openMounted = undefined;
    };
  }, []);

  const isOpen = phase === "open";
  const state = isOpen ? "open" : "closed";
  const closedSize = { ...SIZE.closed, width: fieldWidth };
  const openSize = { ...SIZE.open, width: openWidth };
  const transition = { duration: reduceMotion ? 0 : 0.24, ease };

  return (
    <>
      {/* While the box is up it sits exactly over the field, so the field steps aside: the same
          frame the box goes, the field is back, pixel for pixel where the box ended. */}
      <Button
        ref={triggerRef}
        onPress={() => open()}
        aria-label="Search"
        data-search-field
        // In the sidebar, 4px at the end (not 5): the 16px `/` centres on the toggle above it.
        className={`flex h-7 ${side === "start" ? "w-full" : "w-60 min-w-24"} cursor-text items-center gap-2 rounded-lg border border-input bg-background ps-2 ${side === "start" ? "pe-1" : "pe-1.25"} text-sm text-subtle-foreground outline-hidden hover:border-muted-foreground/30 focus-visible:border-ring/70 ${phase === "closed" ? "" : "invisible"}`}
      >
        <IconSearch className="text-muted-foreground" />
        <span className="flex-1 text-start">Search</span>
        <Keyboard className="h-4 min-w-4">/</Keyboard>
      </Button>
      <ModalOverlay
        isOpen={phase !== "closed"}
        onOpenChange={(next) => (next ? open(seed) : close())}
        isDismissable
        className="fixed inset-0 z-40"
      >
        <motion.div
          aria-hidden
          className="absolute inset-0 bg-foreground/10"
          initial={{ opacity: 0 }}
          animate={{ opacity: isOpen ? 1 : 0 }}
          transition={{ duration: 0.2, ease }}
        />
        <Modal className="outline-hidden">
          <Dialog aria-label="Search" className="outline-hidden">
            <motion.div
              // `overflow-clip`, not hidden: a hidden box can still be scrolled, and cmdk scrolling
              // the selected row into view pushed the search row up out of the small box.
              className="fixed flex flex-col overflow-clip border border-input bg-background transition-shadow duration-200 data-[open=true]:shadow-(--shadow-overlay)"
              data-open={isOpen}
              style={anchor}
              initial={reduceMotion ? { ...openSize, opacity: 0 } : closedSize}
              animate={
                reduceMotion
                  ? { ...openSize, opacity: isOpen ? 1 : 0 }
                  : isOpen
                    ? openSize
                    : closedSize
              }
              transition={reduceMotion ? { duration: 0.15, ease } : transition}
              onAnimationComplete={() => phase === "closing" && setPhase("closed")}
            >
              <SearchPanel
                state={reduceMotion ? "open" : state}
                transition={transition}
                onClose={close}
                seed={seed}
              />
            </motion.div>
          </Dialog>
        </Modal>
      </ModalOverlay>
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

function SearchPanel({
  state,
  transition,
  onClose,
  seed,
}: {
  state: "open" | "closed";
  transition: Transition;
  onClose: () => void;
  /** An earlier search to edit: its words fill the field, and it stays in its mailbox. */
  seed?: SearchSeed | undefined;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sweepList = useListSweep();
  const { threads } = useThreads({ view: "inbox" });
  const [q, setQ] = useState(seed?.q ?? "");
  const mailbox = seed?.mailbox;
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
      await queryClient.fetchQuery(searchQuery(query, mailbox));
    } finally {
      setSearching(false);
    }
    // Together: the band slides down the list, under the popover while it closes.
    onClose();
    sweepList(() => navigate({ to: "/search", search: { q: query, mailbox } }));
  };

  return (
    <Command label="Search" loop filter={filter} className="outline-hidden">
      {/* The field's own row, grown into the top bar. Its rule shows only once there's a list
          under it. */}
      <motion.div
        className="flex shrink-0 items-center border-b border-transparent data-[open=true]:border-border"
        data-open={state === "open"}
        initial={BAR.closed}
        animate={BAR[state]}
        transition={transition}
      >
        <motion.span
          className="flex shrink-0 text-muted-foreground *:size-full"
          initial={ICON.closed}
          animate={ICON[state]}
          transition={transition}
        >
          <IconSearch />
        </motion.span>
        <Command.Input
          autoFocus
          value={q}
          onValueChange={setQ}
          placeholder="Search"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-subtle-foreground"
        />
        {/* The key hint turns from the field's "/" into "Esc" in one spot. */}
        <span className="grid *:col-start-1 *:row-start-1 *:justify-self-end">
          <motion.span animate={{ opacity: state === "open" ? 0 : 1 }} transition={transition}>
            <Keyboard>/</Keyboard>
          </motion.span>
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: state === "open" ? 1 : 0 }}
            transition={transition}
          >
            <Keyboard>Esc</Keyboard>
          </motion.span>
        </span>
      </motion.div>

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

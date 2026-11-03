import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Autocomplete } from "react-aria-components/Autocomplete";
import { Button } from "react-aria-components/Button";
import { Header } from "react-aria-components/Header";
import { Input } from "react-aria-components/Input";
import { Menu, MenuItem, MenuSection } from "react-aria-components/Menu";
import { Popover } from "react-aria-components/Popover";
import { SearchField } from "react-aria-components/SearchField";
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
import { useSearch } from "@/hooks/use-mail.ts";

// Search and commands in one popover anchored to the title-bar field (Vercel's Find as the
// reference): focusing it dims the app and opens the list attached to the field, not centered.
// "/" or ⌘K opens it from anywhere. Mail results come from `useSearch`: threads, best first.

interface Command {
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  href: string;
}

const COMMANDS: Command[] = [
  {
    id: "compose",
    title: "Compose",
    subtitle: "New message",
    icon: <IconWrite />,
    href: "/compose",
  },
  {
    id: "inbox",
    title: "Inbox",
    subtitle: "Mail to attend to",
    icon: <IconInbox />,
    href: "/inbox",
  },
  { id: "queue", title: "Queue", subtitle: "Deferred mail", icon: <IconClock />, href: "/queue" },
  {
    id: "needs-reply",
    title: "Needs reply",
    subtitle: "Waiting on you",
    icon: <IconBubble />,
    href: "/inbox?lane=needs_reply",
  },
  {
    id: "awaiting-reply",
    title: "Awaiting reply",
    subtitle: "Waiting on them",
    icon: <IconBubbleAnnotation />,
    href: "/inbox?lane=waiting_on_them",
  },
  { id: "all", title: "All mail", subtitle: "Every thread", icon: <IconEmail />, href: "/all" },
  {
    id: "settings",
    title: "Settings",
    subtitle: "Workspace",
    icon: <IconSettings />,
    href: "/settings",
  },
];

/** The closed state: a 32px field in the title bar. */
export function SearchPopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // "/" (outside text fields) and ⌘K / Ctrl+K open it from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable=true]");
      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !typing)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Button
        ref={triggerRef}
        onPress={() => setOpen(true)}
        aria-label="Search"
        className="flex h-8 w-60 cursor-text items-center gap-2 rounded-lg border border-input bg-background ps-2 pe-1.5 text-sm text-subtle-foreground outline-hidden hover:border-muted-foreground/30 focus-visible:border-ring/70"
      >
        <IconSearch className="text-muted-foreground" />
        <span className="flex-1 text-start">Search</span>
        <Keyboard>/</Keyboard>
      </Button>
      {open &&
        createPortal(
          // Dims the app behind the popover; a click on it closes the popover (outside click).
          <div aria-hidden className="fixed inset-0 z-40 bg-foreground/10" />,
          document.body,
        )}
      <Popover
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={setOpen}
        placement="bottom end"
        // Opens over the field itself: its top edge sits where the field's top edge is.
        offset={-32}
        className="z-50 w-100 overflow-hidden rounded-xl border border-border bg-background shadow-lg outline-hidden"
      >
        <SearchPanel onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const router = useRouter();
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 150);
  const { data: hits } = useSearch(query);
  // One row per thread, best match first.
  const threads = query ? (hits ?? []).slice(0, 6) : [];

  const commands = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? COMMANDS.filter((c) => c.title.toLowerCase().includes(needle)) : COMMANDS;
  }, [q]);

  const go = (href: string) => {
    onClose();
    void router.navigate({ href });
  };

  return (
    <Autocomplete inputValue={q} onInputChange={setQ}>
      <SearchField
        aria-label="Search mail or jump to"
        autoFocus
        onSubmit={(value) =>
          value.trim() && (onClose(), void navigate({ to: "/search", search: { q: value.trim() } }))
        }
        className="flex h-12 items-center gap-2.5 border-b border-border px-3"
      >
        <IconSearch className="shrink-0 text-muted-foreground" />
        <Input
          placeholder="Search mail or jump to…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        <Keyboard>Esc</Keyboard>
      </SearchField>

      {/* One fixed height (the empty state, seven commands) so the panel never jumps while typing; more results scroll. */}
      <Menu
        aria-label="Results"
        onAction={(key) => {
          const id = String(key);
          if (id === "search-all")
            return (onClose(), void navigate({ to: "/search", search: { q: q.trim() } }));
          if (id.startsWith("thread:")) {
            onClose();
            return void navigate({
              to: "/search/$threadId",
              params: { threadId: id.slice("thread:".length) },
              search: { q: q.trim() },
            });
          }
          const command = COMMANDS.find((c) => c.id === id);
          if (command) go(command.href);
        }}
        className="flex h-97.5 flex-col gap-0.5 overflow-y-auto p-1.5 outline-hidden"
      >
        {q.trim() && (
          <MenuSection className="flex flex-col gap-0.5">
            <SectionHeader>Mail</SectionHeader>
            <Row
              id="search-all"
              icon={<IconSearch />}
              title={`Search all mail for “${q.trim()}”`}
              subtitle="Full results"
            />
            {threads.map((hit) => (
              <Row
                key={hit.threadId}
                id={`thread:${hit.threadId}`}
                icon={<IconEmail />}
                title={hit.subject || "(no subject)"}
                subtitle={`${hit.from.name || hit.from.address} · ${formatDate(hit.sentAt)} · ${hit.snippet}`}
              />
            ))}
          </MenuSection>
        )}
        {commands.length > 0 && (
          <MenuSection className="flex flex-col gap-0.5">
            <SectionHeader>Go to</SectionHeader>
            {commands.map((c) => (
              <Row key={c.id} id={c.id} icon={c.icon} title={c.title} subtitle={c.subtitle} />
            ))}
          </MenuSection>
        )}
      </Menu>
    </Autocomplete>
  );
}

function SectionHeader({ children }: { children: string }) {
  return <Header className="px-2.5 pt-2 pb-1 text-xs text-subtle-foreground">{children}</Header>;
}

/** A 48px two-line row: icon, title, and a short line about it. Focus gets the accent fill. */
function Row(props: { id: string; icon: ReactNode; title: string; subtitle: string }) {
  return (
    <MenuItem
      id={props.id}
      textValue={props.title}
      className="group flex h-12 shrink-0 cursor-default items-center gap-2.5 rounded-lg px-2.5 outline-hidden data-focused:bg-accent"
    >
      <span className="flex shrink-0 text-muted-foreground group-data-focused:text-foreground">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{props.title}</span>
        <span className="truncate text-xs text-muted-foreground">{props.subtitle}</span>
      </span>
    </MenuItem>
  );
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

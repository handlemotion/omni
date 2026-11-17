import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { defaultFilter } from "cmdk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconArchive,
  IconCheck,
  IconCircleCheck,
  IconClockSnooze,
  IconFileText,
  IconKeyboard,
  IconMailOpen,
  IconNote,
  IconReply,
  IconRestore,
  IconUserAdd,
  IconX,
} from "@/components/icons/central";
import { IconEmail, IconSearch, IconWrite } from "@/components/icons/sidebar";
import { useListSweep } from "@/components/inbox/list-sweep";
import {
  type PageDefinition,
  useAccountPages,
  useWorkspacePages,
} from "@/components/settings/settings-pages";
import {
  Command,
  CommandDetail,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandScopes,
  CommandShortcut,
} from "@/components/ui/command";
import { Loader } from "@/components/ui/loader";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useThreads } from "@/hooks/use-mail.ts";
import { runShortcut, useAvailableShortcuts, useShortcut } from "@/hooks/use-shortcuts.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { searchQuery } from "@/lib/mail-queries.ts";
import { COMMAND_IDS, keyLabel, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts.ts";
import { senderLabel } from "@/lib/threads.ts";
import { workspaceHref } from "@/lib/workspaces.ts";
import { CRM_PAGES, drivePages, MAIL_PAGES, type Page } from "./command-pages";

// The command menu: a centred cmdk modal over the dimmed app (transitive's workspace search as
// the reference). "/" or ⌘K opens it from anywhere in a workspace; ⌘K closes it again. Its pills
// scope it to a module (Mail, Drive, CRM) or to Settings, as transitive's do. Typing filters in
// the browser; "Smart search" asks the server for mail and shows the results in the main list,
// at `/<workspace>/mail/search?q=`.

/** What search opens holding: the words already searched, and the mailbox they were scoped to. */
export interface SearchSeed {
  q: string;
  mailbox?: string | undefined;
}
/** The mounted menu's opener; set while it is (the workspace shell mounts one). */
let openMounted: ((seed?: SearchSeed) => void) | undefined;
/**
 * Opens the menu from a control elsewhere (the list's search field), as `/` does; with a `seed`,
 * to edit that search (an empty result's Edit search).
 */
export const openSearch = (seed?: SearchSeed) => openMounted?.(seed);

// Every command row leads with an icon (DESIGN.md, Menus). Go-to keys show on their pages.
const COMMAND_ICONS: Partial<Record<ShortcutId, ReactNode>> = {
  compose: <IconWrite />,
  reply: <IconReply />,
  note: <IconNote />,
  done: <IconCheck />,
  later: <IconArchive />,
  read: <IconMailOpen />,
  close: <IconX />,
  assignToMe: <IconUserAdd />,
  resolve: <IconCircleCheck />,
  snooze: <IconClockSnooze />,
  cannedReply: <IconFileText />,
  undo: <IconRestore />,
  help: <IconKeyboard />,
};
const COMMANDS = COMMAND_IDS.filter((id) => id in COMMAND_ICONS);

type Scope = "all" | "mail" | "files" | "crm" | "settings";
const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mail", label: "Mail" },
  { id: "files", label: "Drive" },
  { id: "crm", label: "CRM" },
  { id: "settings", label: "Settings" },
];

const FOOTER = [
  { keys: "↑↓", label: "Navigate" },
  { keys: "↵", label: "Open" },
  { keys: "Esc", label: "Close" },
];

/** A shortcut's first key sequence as key caps: `G` `I`, or `⌘` `K`. */
const keysOf = (id: ShortcutId) => (SHORTCUTS[id].keys[0] ?? []).flatMap(keyLabel);

// Rows match on their keywords (title, sender), not on their value, which is just a unique id.
// Smart search always matches: it searches the server for whatever was typed.
const SMART = "smart-search";
const filter = (value: string, search: string, keywords?: string[]) =>
  value === SMART ? 1 : defaultFilter("", search, keywords);

/** Mounted once by the workspace shell: binds `/` and ⌘K and renders the menu. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<SearchSeed | undefined>();
  const show = (next?: SearchSeed) => {
    setSeed(next);
    setOpen(true);
  };
  useShortcut("search", () => show());
  useShortcut("commandMenu", () => (open ? setOpen(false) : show()));
  useEffect(() => {
    openMounted = show;
    return () => {
      if (openMounted === show) openMounted = undefined;
    };
  });

  return (
    <CommandDialog label="Search and commands" isOpen={open} onOpenChange={setOpen}>
      <MenuPanel seed={seed} onClose={() => setOpen(false)} />
    </CommandDialog>
  );
}

/**
 * What each pill shows. All holds every module's places and the commands; inbox mail and
 * settings join it once there's a query (transitive's All waits for one too). A module's pill
 * holds that module only; Mail's lists its inbox before any query.
 */
function sections(scope: Scope, query: string) {
  const all = scope === "all";
  return {
    mail: all || scope === "mail",
    files: all || scope === "files",
    crm: all || scope === "crm",
    commands: all || scope === "mail",
    messages: (all && !!query) || scope === "mail",
    smart: !!query && (all || scope === "mail"),
    settings: (all && !!query) || scope === "settings",
  };
}

/** The menu's content, mounted only while the menu is (so each opening starts fresh). */
function MenuPanel({ seed, onClose }: { seed?: SearchSeed | undefined; onClose: () => void }) {
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sweepList = useListSweep();
  const available = useAvailableShortcuts();
  const company = useHasCrm();
  const settingsPages = [...useAccountPages(), ...useWorkspacePages()];
  const { threads } = useThreads({ view: "inbox" });
  const [q, setQ] = useState(seed?.q ?? "");
  const mailbox = seed?.mailbox;
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const input = useRef<HTMLInputElement>(null);
  const query = q.trim();
  const show = sections(scope, query);

  // A command runs once the menu is gone: run now, the closing modal would take focus back from
  // whatever the command focuses (the reply composer).
  const afterClose = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      afterClose.current?.();
      afterClose.current = null;
    },
    [],
  );
  const runCommand = (id: ShortcutId) => {
    afterClose.current = () => runShortcut(id);
    onClose();
  };
  const go = (href: string) => {
    onClose();
    void router.navigate({ href: workspaceHref(workspace, href) });
  };
  const openPage = (page: Page) => {
    if (page.shortcut && runShortcut(page.shortcut)) onClose();
    else go(page.href);
  };
  const openThread = (threadId: string) => {
    onClose();
    void navigate({ to: "/$workspace/mail/inbox/$threadId", params: { workspace, threadId } });
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
    onClose();
    sweepList(() =>
      navigate({
        to: "/$workspace/mail/search",
        params: { workspace },
        search: { q: query, mailbox },
      }),
    );
  };

  // No vim keys: cmdk would take Ctrl+K (previous row), which closes the menu off a Mac.
  return (
    <Command label="Search and commands" loop filter={filter} vimBindings={false}>
      <CommandInput ref={input} autoFocus value={q} onValueChange={setQ} placeholder="Search…" />
      <CommandScopes
        scopes={company ? SCOPES : SCOPES.filter((s) => s.id !== "crm")}
        value={scope}
        onChange={(next) => {
          setScope(next);
          input.current?.focus();
        }}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {show.mail && <PageGroup heading="Mail" pages={MAIL_PAGES} onOpen={openPage} />}
        {show.files && <PageGroup heading="Drive" pages={drivePages(company)} onOpen={openPage} />}
        {show.crm && company && <PageGroup heading="CRM" pages={CRM_PAGES} onOpen={openPage} />}
        {show.commands && (
          <CommandGroup heading="Commands">
            {COMMANDS.filter((id) => available.has(id)).map((id) => (
              <CommandItem
                key={id}
                value={`command:${id}`}
                keywords={[SHORTCUTS[id].label]}
                onSelect={() => runCommand(id)}
              >
                {COMMAND_ICONS[id]}
                <span className="min-w-0 truncate">{SHORTCUTS[id].label}</span>
                <CommandShortcut keys={keysOf(id)} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {show.messages && <MessageGroup threads={threads} onOpen={openThread} />}
        {show.settings && (
          <SettingsGroup pages={settingsPages} onOpen={(id) => go(`/settings/${id}`)} />
        )}
        {/* Last: cmdk orders rows within a group, not the groups, so Enter takes the first match
            above and smart search is the fallback when nothing here matches. */}
        {show.smart && (
          <CommandGroup>
            <CommandItem value={SMART} onSelect={() => void smartSearch()}>
              {searching ? <Loader /> : <IconSearch />}
              <span className={`min-w-0 truncate ${searching ? "shimmer" : ""}`}>
                Smart search for “{query}”
              </span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <CommandFooter hints={FOOTER} />
    </Command>
  );
}

/** A module's places, headed by the module's name. */
function PageGroup(props: { heading: string; pages: Page[]; onOpen: (page: Page) => void }) {
  return (
    <CommandGroup heading={props.heading}>
      {props.pages.map((page) => (
        <CommandItem
          key={page.id}
          value={`page:${page.id}`}
          keywords={[page.title, props.heading]}
          onSelect={() => props.onOpen(page)}
        >
          {page.icon}
          <span className="min-w-0 truncate">{page.title}</span>
          {page.shortcut && <CommandShortcut keys={keysOf(page.shortcut)} />}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Settings pages, found by title and by the words on them, as the settings nav's search does. */
function SettingsGroup(props: { pages: PageDefinition[]; onOpen: (id: string) => void }) {
  return (
    <CommandGroup heading="Settings">
      {props.pages.map((page) => (
        <CommandItem
          key={page.id}
          value={`settings:${page.id}`}
          keywords={[page.title, "settings", ...page.terms]}
          onSelect={() => props.onOpen(page.id)}
        >
          {page.icon}
          <span className="min-w-0 truncate">{page.title}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Inbox mail, matched on subject and sender; each opens in the inbox. */
function MessageGroup(props: {
  threads: ReturnType<typeof useThreads>["threads"];
  onOpen: (threadId: string) => void;
}) {
  return (
    <CommandGroup heading="Inbox">
      {props.threads.map((thread) => {
        const sender = senderLabel(thread);
        return (
          <CommandItem
            key={thread.id}
            value={`thread:${thread.id}`}
            keywords={[thread.subject, sender]}
            onSelect={() => props.onOpen(thread.id)}
          >
            <IconEmail />
            <span className="min-w-0 truncate">{thread.subject || "(no subject)"}</span>
            <CommandDetail>{sender}</CommandDetail>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

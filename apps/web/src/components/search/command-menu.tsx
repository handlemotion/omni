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
import { IconSearch, IconWrite } from "@/components/icons/sidebar";
import { useListSweep } from "@/components/inbox/list-sweep";
import {
  type PageDefinition,
  useAccountPages,
  useWorkspacePages,
} from "@/components/settings/settings-pages";
import {
  Command,
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
import { EmptyState } from "@/components/empty/empty-state";
import { Loader } from "@/components/ui/loader";
import { useStorageHref } from "@/components/storage/file-list.tsx";
import { useCommandSearch, useWarmCommandSearch } from "@/hooks/use-command-search.ts";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useThreads } from "@/hooks/use-mail.ts";
import { runShortcut, useAvailableShortcuts, useShortcut } from "@/hooks/use-shortcuts.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { searchQuery } from "@/lib/mail-queries.ts";
import { COMMAND_IDS, keyLabel, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts.ts";
import type { FileHit } from "@/hooks/use-command-search.ts";
import { workspaceHref } from "@/lib/workspaces.ts";
import { CRM_PAGES, drivePages, MAIL_PAGES, type Page } from "./command-pages";
import { RecordGroups, ResultBones } from "./command-results.tsx";

// The command menu: a centred cmdk modal over the dimmed app (transitive's workspace search as
// the reference). "/" or ⌘K opens it from anywhere in a workspace; ⌘K closes it again. Its pills
// scope it to a module (Mail, Drive, CRM) or to Settings, as transitive's do. Typing finds Drive's
// files and folders, the CRM's records and mail by name, from the cache at once and from the
// server as it answers (`useCommandSearch`); "Smart search" asks the server for mail and shows the
// results in the main list, at `/<workspace>/mail/search?q=`.

export type Scope = "all" | "mail" | "files" | "crm" | "settings";

/**
 * What search opens holding: the words already searched, the mailbox they were scoped to, and
 * the pill it starts on (Drive's Search opens on Drive).
 */
export interface SearchSeed {
  q: string;
  mailbox?: string | undefined;
  scope?: Scope | undefined;
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
// Smart search always matches: it searches the server for whatever was typed. Records are
// already the matches for the text (`useCommandSearch`), some by a field the row doesn't show
// (a company's domain), so they aren't filtered again.
const SMART = "smart-search";
const RECORD = /^(node|company|person|deal|thread):/;
const filter = (value: string, search: string, keywords?: string[]) =>
  value === SMART || RECORD.test(value) ? 1 : defaultFilter("", search, keywords);

/** Mounted once by the workspace shell: binds `/` and ⌘K and renders the menu. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<SearchSeed | undefined>();
  // Each opening mounts a fresh panel, even one made while the last is still animating out.
  const [opening, setOpening] = useState(0);
  const show = (next?: SearchSeed) => {
    setSeed(next);
    setOpening((n) => n + 1);
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
      <MenuPanel key={opening} seed={seed} onClose={() => setOpen(false)} />
    </CommandDialog>
  );
}

/**
 * What each pill shows. All holds every module's places and the commands; records, mail and
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
  const storageHref = useStorageHref();
  const { threads: inbox } = useThreads({ view: "inbox" });
  const [q, setQ] = useState(seed?.q ?? "");
  const mailbox = seed?.mailbox;
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<Scope>(seed?.scope ?? "all");
  useWarmCommandSearch(company);
  const hits = useCommandSearch(q, company);
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
    // A found thread may be anywhere: one in the inbox opens there, any other in All mail.
    const inInbox = inbox.some((thread) => thread.id === threadId);
    const to = inInbox ? "/$workspace/mail/inbox/$threadId" : "/$workspace/mail/all/$threadId";
    void navigate({ to, params: { workspace, threadId } });
  };
  const openNode = (node: FileHit) => {
    onClose();
    // Shared with the member from elsewhere: its link opens it.
    if (node.shareId) {
      void router.navigate({ href: `/s/${encodeURIComponent(node.shareId)}` });
      return;
    }
    if (node.kind === "folder") {
      void router.navigate({ href: storageHref(node.space, node.id) });
      return;
    }
    const folder = storageHref(node.space, node.parentId ?? undefined);
    const file = `file=${encodeURIComponent(node.id)}`;
    void router.navigate({ href: `${folder}${folder.includes("?") ? "&" : "?"}${file}` });
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
        {/* Nothing found fills the list, centred, as every empty state in the app is. */}
        <CommandEmpty className={hits.searching ? undefined : "absolute inset-0 flex py-0"}>
          {hits.searching ? (
            <ResultBones />
          ) : (
            <EmptyState figure="loupe" title="Nothing matches" className="p-4 pb-10" />
          )}
        </CommandEmpty>
        {show.mail && <PageGroup heading="Mail" pages={MAIL_PAGES} onOpen={openPage} />}
        {show.files && <PageGroup heading="Drive" pages={drivePages(company)} onOpen={openPage} />}
        {show.crm && company && <PageGroup heading="CRM" pages={CRM_PAGES} onOpen={openPage} />}
        <RecordGroups
          show={show}
          query={query}
          hits={hits}
          inbox={inbox}
          onNode={openNode}
          onPath={go}
          onThread={openThread}
        />
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

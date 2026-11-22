import { driveOf } from "@/lib/storage.ts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { defaultFilter } from "cmdk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconArchive,
  IconCheck,
  IconCircleCheck,
  IconFileText,
  IconKeyboard,
  IconMailOpen,
  IconNote,
  IconReply,
  IconRestore,
  IconUserAdd,
  IconX,
} from "@/components/icons/central";
import { IconWrite } from "@/components/icons/sidebar";
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
import { useStorageHref } from "@/components/storage/file-list.tsx";
import { useCommandSearch, useWarmCommandSearch } from "@/hooks/use-command-search.ts";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useThreads } from "@/hooks/use-mail.ts";
import { runShortcut, useAvailableShortcuts, useShortcut } from "@/hooks/use-shortcuts.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { COMMAND_IDS, keyLabel, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts.ts";
import type { FileHit } from "@/hooks/use-command-search.ts";
import { workspaceHref } from "@/lib/workspaces.ts";
import { CRM_PAGES, drivePages, MAIL_PAGES, type Page } from "./command-pages";
import { RecordGroups, ResultBones } from "./command-results.tsx";

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
let openMounted: ((seed?: SearchSeed) => void) | undefined;
/**
 * Opens the menu from a control elsewhere (the list's search field), as `/` does; with a `seed`,
 * to edit that search (an empty result's Edit search).
 */
export const openSearch = (seed?: SearchSeed) => openMounted?.(seed);

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
  cannedReply: <IconFileText />,
  undo: <IconRestore />,
  help: <IconKeyboard />,
};
const COMMANDS = COMMAND_IDS.filter((id) => id in COMMAND_ICONS);

const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mail", label: "Mail" },
  { id: "files", label: "Drive" },
  { id: "crm", label: "Clients" },
  { id: "settings", label: "Settings" },
];

const FOOTER = [
  { keys: "↑↓", label: "Navigate" },
  { keys: "↵", label: "Open" },
  { keys: "Esc", label: "Close" },
];

const keysOf = (id: ShortcutId) => (SHORTCUTS[id].keys[0] ?? []).flatMap(keyLabel);

const RECORD = /^(node|company|person|deal|task|thread):/;
const filter = (value: string, search: string, keywords?: string[]) =>
  RECORD.test(value) ? 1 : defaultFilter("", search, keywords);

/** Mounted once by the workspace shell: binds `/` and ⌘K and renders the menu. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<SearchSeed | undefined>();
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

function sections(scope: Scope, query: string) {
  const all = scope === "all";
  return {
    mail: all || scope === "mail",
    files: all || scope === "files",
    crm: all || scope === "crm",
    commands: all || scope === "mail",
    messages: (all && !!query) || scope === "mail",
    settings: (all && !!query) || scope === "settings",
  };
}

function MenuPanel({ seed, onClose }: { seed?: SearchSeed | undefined; onClose: () => void }) {
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const router = useRouter();
  const available = useAvailableShortcuts();
  const company = useHasCrm();
  const settingsPages = [...useAccountPages(), ...useWorkspacePages()];
  const storageHref = useStorageHref();
  const { threads: inbox } = useThreads({ view: "inbox" });
  const [q, setQ] = useState(seed?.q ?? "");
  const [scope, setScope] = useState<Scope>(seed?.scope ?? "all");
  useWarmCommandSearch(company);
  const hits = useCommandSearch(q, company);
  const input = useRef<HTMLInputElement>(null);
  const query = q.trim();
  const show = sections(scope, query);

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
    const inInbox = inbox.some((thread) => thread.id === threadId);
    const to = inInbox ? "/$workspace/mail/inbox/$threadId" : "/$workspace/mail/all/$threadId";
    void navigate({ to, params: { workspace, threadId } });
  };
  const openNode = (node: FileHit) => {
    onClose();
    if (node.shareId) {
      void router.navigate({ href: `/s/${encodeURIComponent(node.shareId)}` });
      return;
    }
    if (node.kind === "folder") {
      void router.navigate({ href: storageHref(driveOf(node), node.id) });
      return;
    }
    const folder = storageHref(driveOf(node), node.parentId ?? undefined);
    const file = `file=${encodeURIComponent(node.id)}`;
    void router.navigate({ href: `${folder}${folder.includes("?") ? "&" : "?"}${file}` });
  };

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
        <CommandEmpty className={hits.searching ? undefined : "absolute inset-0 flex py-0"}>
          {hits.searching ? (
            <ResultBones />
          ) : (
            <EmptyState figure="loupe" title="Nothing matches" className="p-4 pb-10" />
          )}
        </CommandEmpty>
        {show.mail && <PageGroup heading="Mail" pages={MAIL_PAGES} onOpen={openPage} />}
        {show.files && <PageGroup heading="Drive" pages={drivePages(company)} onOpen={openPage} />}
        {show.crm && company && <PageGroup heading="Clients" pages={CRM_PAGES} onOpen={openPage} />}
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
      </CommandList>
      <CommandFooter hints={FOOTER} />
    </Command>
  );
}

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

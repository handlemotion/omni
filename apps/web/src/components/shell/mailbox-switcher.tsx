// The mailbox switcher in the sidebar header: which mailbox the app shows, or all of them. The
// UX follows a mail app's account menu (All, then each mailbox, then manage and log out); the
// rows follow the search menu's, taller here to fit a name over the address. Workspaces only
// show as headings when the user belongs to more than one.
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { useSearch } from "@tanstack/react-router";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import { useMember, useSignOut } from "@/hooks/use-session.ts";
import { useOpenMailbox, useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace, WorkspaceMailbox } from "@/lib/types.ts";

/** Taller than a menu row: a name over an address, like the search menu's rows. */
const ROW = "min-h-12 rounded-lg px-2.5 py-1.5";
const ROW_CONTENT = "col-span-full flex min-w-0 items-center gap-2.5";

/** What a mailbox is called: you, for your personal one; its local part for a shared one. */
function mailboxName(mailbox: WorkspaceMailbox, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function Initial(props: { name: string; loading?: boolean }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center">
      {props.loading ? (
        <Loader className="size-4 text-muted-foreground" />
      ) : (
        <Avatar
          initials={props.name.slice(0, 1).toUpperCase()}
          className="bg-accent text-foreground outline-0 [--avatar-size:--spacing(7)]"
        />
      )}
    </span>
  );
}

/** The two lines of a row and the check on the one showing. */
function RowBody(props: { name: string; detail: string; chosen: boolean; loading?: boolean }) {
  return (
    <span className={ROW_CONTENT}>
      <Initial name={props.name} loading={props.loading} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground">{props.name}</span>
        <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
      </span>
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        {props.chosen && <CheckIcon className="size-4 text-foreground" />}
      </span>
    </span>
  );
}

const failed = () => appToast.error("The mailbox could not be opened. Try again.");

export function MailboxSwitcher() {
  const { user, member } = useMember();
  const workspaces = useWorkspaces();
  const openWorkspace = useOpenWorkspace();
  const openMailbox = useOpenMailbox();
  const signOut = useSignOut();
  const { mailbox: current } = useSearch({ strict: false }) as { mailbox?: string };

  const all = workspaces.data?.workspaces ?? [];
  const grouped = all.length > 1;
  const you = user.name || user.email;
  const active = all.find((workspace) => workspace.id === member.orgId);
  const shown = active?.mailboxes.find((box) => box.id === current);
  const pending = openWorkspace.isPending || openMailbox.isPending;

  const showAll = (workspace: Workspace) => openWorkspace.mutate(workspace, { onError: failed });
  const show = (workspace: Workspace, mailbox: WorkspaceMailbox) =>
    openMailbox.mutate({ workspaceId: workspace.id, mailboxId: mailbox.id }, { onError: failed });

  const triggerName = shown ? mailboxName(shown, you) : "All mailboxes";

  // One workspace's rows: All, then each mailbox.
  const rows = (workspace: Workspace) => [
    <MenuItem
      key={`${workspace.id}:all`}
      className={ROW}
      textValue={grouped ? `All mailboxes in ${workspace.name}` : "All mailboxes"}
      onAction={() => showAll(workspace)}
    >
      <RowBody
        name="All mailboxes"
        detail={`${workspace.mailboxes.length} total`}
        chosen={workspace.id === member.orgId && !shown}
      />
    </MenuItem>,
    ...workspace.mailboxes.map((mailbox) => (
      <MenuItem
        key={mailbox.id}
        className={ROW}
        textValue={mailbox.address}
        onAction={() => show(workspace, mailbox)}
      >
        <RowBody
          name={mailboxName(mailbox, you)}
          detail={mailbox.address}
          chosen={workspace.id === member.orgId && mailbox.id === current}
        />
      </MenuItem>
    )),
  ];

  return (
    <MenuTrigger>
      <Button
        intent="plain"
        aria-label={`Switch mailbox, currently ${triggerName}`}
        className="h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-sm px-2 hover:bg-hover aria-expanded:bg-hover"
      >
        <span className="grid size-4.5 shrink-0 place-items-center">
          {pending ? (
            <Loader className="size-3.5 text-muted-foreground" />
          ) : (
            <Avatar
              initials={triggerName.slice(0, 1).toUpperCase()}
              className="bg-accent text-foreground outline-0 [--avatar-size:--spacing(4.5)]"
            />
          )}
        </span>
        <span className="min-w-0 truncate">{triggerName}</span>
        <ChevronUpDownIcon className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>

      <Menu
        placement="bottom start"
        popover={{ offset: 8, className: "w-80 max-w-[calc(100vw-16px)]" }}
        className="p-1.5"
      >
        {grouped
          ? all.map((workspace) => (
              <MenuSection key={workspace.id} label={workspace.name}>
                {rows(workspace)}
              </MenuSection>
            ))
          : active && rows(active)}

        <MenuSeparator />

        <MenuItem href="/settings" textValue="Manage mailboxes">
          Manage mailboxes…
        </MenuItem>
        <MenuItem
          textValue="Log out"
          isDisabled={signOut.isPending}
          shouldCloseOnSelect={false}
          onAction={() => signOut.mutate()}
        >
          <span className={signOut.isPending ? "shimmer" : undefined}>Log out</span>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

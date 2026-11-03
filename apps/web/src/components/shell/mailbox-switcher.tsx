// The mailbox switcher in the sidebar header: which mailbox the app shows, or all of them. The
// UX follows a mail app's account menu (All, then each mailbox, then manage and log out); the
// rows follow the search menu's, taller here to fit a name over the address. Workspaces only
// show as headings when the user belongs to more than one.
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { useSearch } from "@tanstack/react-router";
import { IconCircleDashed, IconSettings } from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import { useMember, useSignOut } from "@/hooks/use-session.ts";
import { useOpenMailbox, useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace, WorkspaceMailbox } from "@/lib/types.ts";

/**
 * Every row, mailbox or action: 40px like the search menu's rows, 6px inside top and bottom. With
 * the menu's 6px padding, the divider's 6px margins and the group labels' 6px padding, content
 * sits 12px from content everywhere: menu edge, group label, divider. Same inset left and right,
 * so icons line up with the avatars.
 */
const ROW = "min-h-10 rounded-sm px-2.5 py-1.5";
const ROW_CONTENT = "col-span-full flex min-w-0 items-center gap-3";
/** A footer row: a 16px icon in the avatar's column, then its label. */
const ACTION_CONTENT = "col-span-full flex min-w-0 items-center gap-3";
/** Rounded squares like the mail list's avatars. Multiply: under the row's hover highlight the
 *  fill darkens with it instead of sitting on top as a flat grey tile. */
const AVATAR =
  "bg-accent text-foreground outline-0 mix-blend-multiply [--avatar-radius:var(--radius-sm)]";

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
          isSquare
          initials={props.name.slice(0, 1).toUpperCase()}
          className={`${AVATAR} [--avatar-size:--spacing(7)]`}
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
        <span className="truncate text-xs/3 text-muted-foreground">{props.detail}</span>
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
        // Hover, pressed and open share one fill. React Aria keeps the trigger pressed while its
        // menu is open, so the fill is set through the button's own variables.
        className="h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-sm px-2 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
        <span className="grid size-4.5 shrink-0 place-items-center">
          {pending ? (
            <Loader className="size-3.5 text-muted-foreground" />
          ) : (
            <Avatar
              isSquare
              initials={triggerName.slice(0, 1).toUpperCase()}
              className={`${AVATAR} [--avatar-size:--spacing(4.5)]`}
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
              // `mt-0`: the label's own padding already spaces the groups (12px content to content).
              <MenuSection key={workspace.id} label={workspace.name} className="mt-0">
                {rows(workspace)}
              </MenuSection>
            ))
          : active && rows(active)}

        {/* Full width: through the menu's padding, edge to edge. */}
        <MenuSeparator className="-mx-1.5 my-1.5" />

        <MenuItem href="/settings" className={ROW} textValue="Manage mailboxes">
          <span className={ACTION_CONTENT}>
            <span className="grid size-7 shrink-0 place-items-center">
              <IconSettings className="size-4 text-muted-foreground" />
            </span>
            Manage mailboxes…
          </span>
        </MenuItem>
        <MenuItem
          className={ROW}
          textValue="Log out"
          isDisabled={signOut.isPending}
          shouldCloseOnSelect={false}
          onAction={() => signOut.mutate()}
        >
          <span className={ACTION_CONTENT}>
            <span className="grid size-7 shrink-0 place-items-center">
              {signOut.isPending ? (
                <Loader className="size-4 text-muted-foreground" />
              ) : (
                <IconCircleDashed className="size-4 text-muted-foreground" />
              )}
            </span>
            Log out
          </span>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

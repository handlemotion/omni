// The mailbox switcher in the sidebar header: which mailbox the app shows, or all of them. The
// UX follows a mail app's account menu (All, then each mailbox); the rows follow the search
// menu's, taller to fit a name over the address. Settings and log out live in the sidebar footer.
// Workspaces only show as headings when the user belongs to more than one.
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { useSearch } from "@tanstack/react-router";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuSection, MenuTrigger } from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import { useMember } from "@/hooks/use-session.ts";
import { useOpenMailbox, useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace, WorkspaceMailbox } from "@/lib/types.ts";

/**
 * Every row: 40px like the search menu's, 6px inside top and bottom. With the menu's 6px padding
 * and the group labels' 6px padding, content sits 12px from content everywhere.
 */
const ROW = "min-h-10 rounded-sm px-2.5 py-1.5";
const ROW_CONTENT = "col-span-full flex min-w-0 items-center gap-3";
/** Multiply: under the row's hover highlight the fill darkens with it instead of sitting on top
 *  as a flat grey disc. */
const AVATAR = "bg-accent text-foreground outline-0 mix-blend-multiply";

const failed = () => appToast.error("The mailbox could not be opened. Try again.");

/** What a mailbox is called: you, for your personal one; its local part for a shared one. */
function mailboxName(mailbox: WorkspaceMailbox, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** One round avatar, `size` px across; `plain` leaves out the initial. */
function Initial({ name, size, plain }: { name: string; size: number; plain?: boolean }) {
  return (
    <Avatar
      initials={plain ? undefined : name.slice(0, 1).toUpperCase()}
      className={AVATAR}
      style={{ "--avatar-size": `${size}px` } as React.CSSProperties}
    />
  );
}

/**
 * "All mailboxes": three plain discs spread over one avatar's square, a large one at the top left
 * and two smaller ones to the right and below, apart so none hides another. Plain: at these sizes
 * an initial is an unreadable speck, and the group reads as one mark. Drawn from fractions of
 * `size`, so the trigger and the row show the same arrangement.
 */
function Cluster({ names, size }: { names: string[]; size: number }) {
  const spots = [
    { s: 0.6, x: 0, y: 0 },
    { s: 0.42, x: 0.58, y: 0.3 },
    { s: 0.36, x: 0.16, y: 0.64 },
  ];
  return (
    <span aria-hidden className="relative shrink-0" style={{ width: size, height: size }}>
      {names.slice(0, 3).map((name, i) => {
        const spot = spots[i]!;
        return (
          <span
            key={`${name}-${i}`}
            className="absolute flex"
            style={{ left: spot.x * size, top: spot.y * size }}
          >
            <Initial plain name={name} size={Math.round(spot.s * size)} />
          </span>
        );
      })}
    </span>
  );
}

/** The two lines of a row and the check on the one showing. */
function RowBody(props: { lead: React.ReactNode; name: string; detail: string; chosen: boolean }) {
  return (
    <span className={ROW_CONTENT}>
      <span className="grid size-7 shrink-0 place-items-center">{props.lead}</span>
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

export function MailboxSwitcher() {
  const { user, member } = useMember();
  const workspaces = useWorkspaces();
  const openWorkspace = useOpenWorkspace();
  const openMailbox = useOpenMailbox();
  const { mailbox: current } = useSearch({ strict: false }) as { mailbox?: string };

  const all = workspaces.data?.workspaces ?? [];
  const grouped = all.length > 1;
  const you = user.name || user.email;
  const active = all.find((workspace) => workspace.id === member.orgId);
  const shown = active?.mailboxes.find((box) => box.id === current);
  const pending = openWorkspace.isPending || openMailbox.isPending;
  const everyName = all.flatMap((workspace) =>
    workspace.mailboxes.map((mailbox) => mailboxName(mailbox, you)),
  );
  const total = everyName.length;

  const show = (workspace: Workspace, mailbox: WorkspaceMailbox) =>
    openMailbox.mutate({ workspaceId: workspace.id, mailboxId: mailbox.id }, { onError: failed });

  const triggerName = shown ? mailboxName(shown, you) : "All mailboxes";

  const mailboxRows = (workspace: Workspace) =>
    workspace.mailboxes.map((mailbox) => (
      <MenuItem
        key={mailbox.id}
        className={ROW}
        textValue={mailbox.address}
        onAction={() => show(workspace, mailbox)}
      >
        <RowBody
          lead={<Initial name={mailboxName(mailbox, you)} size={28} />}
          name={mailboxName(mailbox, you)}
          detail={mailbox.address}
          chosen={workspace.id === member.orgId && mailbox.id === current}
        />
      </MenuItem>
    ));

  return (
    <MenuTrigger>
      <Button
        intent="plain"
        aria-label={`Switch mailbox, currently ${triggerName}`}
        // Hover, pressed and open share one fill. React Aria keeps the trigger pressed while its
        // menu is open, so the fill is set through the button's own variables.
        className="h-7 min-w-0 flex-1 justify-start gap-2.5 rounded-sm px-2 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
        <span className="grid size-icon shrink-0 place-items-center">
          {pending ? (
            <Loader className="size-icon text-muted-foreground" />
          ) : shown ? (
            <Initial name={triggerName} size={15} />
          ) : (
            <Cluster names={everyName} size={15} />
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
        {/* One All row for every workspace, above the groups. */}
        <MenuItem
          className={ROW}
          textValue="All mailboxes"
          onAction={() => active && openWorkspace.mutate(active, { onError: failed })}
        >
          <RowBody
            lead={<Cluster names={everyName} size={28} />}
            name="All mailboxes"
            detail={`${total} total`}
            chosen={!shown}
          />
        </MenuItem>
        {grouped
          ? all.map((workspace) => (
              // `mt-0`: the label's own padding already spaces the groups (12px content to content).
              <MenuSection key={workspace.id} label={workspace.name} className="mt-0">
                {mailboxRows(workspace)}
              </MenuSection>
            ))
          : active && mailboxRows(active)}
      </Menu>
    </MenuTrigger>
  );
}

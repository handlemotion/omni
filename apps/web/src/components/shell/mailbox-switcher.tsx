// The mailbox switcher in the sidebar header: which mailbox the app shows, or all of them. The
// UX follows a mail app's account menu: All, then each mailbox, grouped by workspace only when
// the user belongs to more than one. Settings and log out live in the sidebar footer.
//
// Geometry, so the menu breathes and balances optically:
// - Every row is 50px: a 32px avatar beside a 34px two-line block (13/16 name, 2px, 11/16
//   address), nothing clipped. Each mark is even inside its own corner of the row: the avatar
//   9px from the row's top and left, the check's ink the same distance from its top and right.
// - The menu's 8px padding puts avatars 17px from its edges.
// - A group label gets room on both sides: 24px under the group above, 16px over its own rows.
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuSection, MenuTrigger } from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import { useMember } from "@/hooks/use-session.ts";
import { useOpenMailbox, useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace, WorkspaceMailbox } from "@/lib/types.ts";

/** Rows are 50px (8px + the 34px text block + 8px). The 32px avatar sits 9px from the row's top
 *  and left; the check's ink 20px from its top and right (measured). Each mark is even inside its
 *  own corner. */
const ROW = "min-h-12 rounded-sm ps-2.25 pe-4.5 py-2";
const ROW_CONTENT = "col-span-full flex min-w-0 items-center gap-3";
/** 16px above (the row before keeps 8px of its own), 8px below (plus the next row's 8px):
 *  24px under the group above, 16px over its own rows. Aligned with the avatars. */
const GROUP_LABEL = "px-2.25 pt-4 pb-2 text-xs/4 sm:px-2.25 sm:pt-4 sm:pb-2 sm:text-xs/4";

const failed = () => appToast.error("The mailbox could not be opened. Try again.");

/** A mailbox as the switcher shows it: who it is and their picture, if any. */
interface Face {
  key: string;
  name: string;
  image: string | null;
}

/** What a mailbox is called: you, for your personal one; its local part for a shared one. */
function mailboxName(mailbox: WorkspaceMailbox, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** A round avatar `size` px across: the picture when there is one, else the initial. Multiply:
 *  under the row's hover highlight the fill darkens with it instead of sitting on top. */
function FaceAvatar(props: { face: Face; size: number; plain?: boolean }) {
  return (
    <Avatar
      src={props.face.image}
      initials={props.plain ? undefined : props.face.name.slice(0, 1).toUpperCase()}
      className="bg-accent text-foreground outline-0 mix-blend-multiply"
      style={{ "--avatar-size": `${props.size}px` } as CSSProperties}
    />
  );
}

/**
 * "All mailboxes": the mailboxes' own avatars in a triangle over one avatar's square, two on top
 * and one below between them. With more than three, the last becomes "+N". Discs are half the
 * square and just touch, so none hides another. A ring in the fill behind them (`ring`) keeps a
 * hairline between neighbours on the menu, under the hover highlight and on the trigger.
 * `plain` drops initials and the count, for sizes where they would be specks.
 */
function Cluster(props: { faces: Face[]; size: number; ring: string; plain?: boolean }) {
  const { faces, size } = props;
  // Half-size discs that just touch, none hiding another: two on top, one centred below.
  const disc = size / 2;
  const spots = [
    { x: 0, y: size / 32 },
    { x: disc, y: size / 32 },
    { x: disc / 2, y: size - disc - size / 32 },
  ];
  const extra = faces.length - 3;
  const shown: (Face | { more: number })[] =
    extra > 0 ? [...faces.slice(0, 2), { more: extra + 1 }] : faces.slice(0, 3);
  return (
    <span aria-hidden className="relative block shrink-0" style={{ width: size, height: size }}>
      {shown.map((item, i) => {
        const spot = spots[i] ?? { x: 0, y: 0 };
        return (
          <span
            key={"more" in item ? "more" : item.key}
            className={cn("absolute flex rounded-full p-[1.5px]", props.ring)}
            style={{ left: spot.x - 1.5, top: spot.y - 1.5 }}
          >
            {"more" in item ? (
              <Avatar
                initials={props.plain ? undefined : `+${item.more}`}
                className="bg-accent text-muted-foreground outline-0 mix-blend-multiply"
                style={{ "--avatar-size": `${disc}px` } as CSSProperties}
              />
            ) : (
              <FaceAvatar face={item} size={disc} plain={props.plain} />
            )}
          </span>
        );
      })}
    </span>
  );
}

/** A row's avatar, two lines and the check on the one showing. */
function RowBody(props: { lead: React.ReactNode; name: string; detail: string; chosen: boolean }) {
  return (
    <span className={ROW_CONTENT}>
      <span className="grid size-8 shrink-0 place-items-center">{props.lead}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm/4 text-foreground">{props.name}</span>
        <span className="truncate text-xs/4 text-muted-foreground">{props.detail}</span>
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
  // A workspace still in setup has no mailboxes yet: no group label with nothing under it.
  const groups = all.filter((workspace) => workspace.mailboxes.length > 0);
  const grouped = groups.length > 1;
  const you = user.name || user.email;
  const face = (mailbox: WorkspaceMailbox): Face => ({
    key: mailbox.id,
    name: mailboxName(mailbox, you),
    image: mailbox.kind === "personal" ? (user.image ?? null) : null,
  });
  const active = all.find((workspace) => workspace.id === member.orgId);
  const shown = active?.mailboxes.find((box) => box.id === current);
  const pending = openWorkspace.isPending || openMailbox.isPending;
  const faces = all.flatMap((workspace) => workspace.mailboxes.map(face));

  // The trigger shares the header with three buttons, leaving its label 65px: "All mailboxes"
  // (99px) would clip, so it says "All" beside the cluster, and a personal mailbox shows the
  // first name. The menu rows and the trigger's accessible name keep the full names.
  const triggerName = shown ? mailboxName(shown, you) : "All mailboxes";
  const triggerLabel = shown
    ? shown.kind === "personal"
      ? (you.split(" ")[0] ?? you)
      : triggerName
    : "All";

  const mailboxRows = (workspace: Workspace) =>
    workspace.mailboxes.map((mailbox) => (
      <MenuItem
        key={mailbox.id}
        className={ROW}
        textValue={mailbox.address}
        onAction={() =>
          openMailbox.mutate(
            { workspaceId: workspace.id, mailboxId: mailbox.id },
            { onError: failed },
          )
        }
      >
        <RowBody
          lead={<FaceAvatar face={face(mailbox)} size={32} />}
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
        // menu is open, so the fill is set through the button's own variables. The lead is the
        // nav icons' 15px box, 8px in, with the label 10px after: the avatar's centre and the
        // label line up with the nav rows below.
        className="group/trigger h-7 min-w-0 flex-1 justify-start gap-2.5 rounded-sm px-2 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
        <span className="grid size-icon shrink-0 place-items-center">
          {pending ? (
            <Loader className="size-icon text-muted-foreground" />
          ) : shown ? (
            // 18px over the 15px box: the grid would start it at the box's left edge (centre
            // 1.5px right of the nav icons'), so the margin centres it on the same axis.
            <span className="-m-[1.5px]">
              <FaceAvatar face={face(shown)} size={18} plain />
            </span>
          ) : (
            // 20px over the 15px box, centred on the same axis; at this size initials are
            // specks, so the discs are plain (pictures still show).
            <span className="-m-[2.5px]">
              <Cluster
                faces={faces}
                size={20}
                plain
                ring="bg-sidebar group-hover/trigger:bg-accent group-aria-expanded/trigger:bg-accent"
              />
            </span>
          )}
        </span>
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronUpDownIcon className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>

      <Menu
        placement="bottom start"
        popover={{
          offset: 8,
          className: "w-80 max-w-[calc(100vw-16px)] [--popover-radius:var(--radius-xl)]",
        }}
        className="p-2"
      >
        {/* One All row for every workspace, above the groups. */}
        <MenuItem
          className={ROW}
          textValue="All mailboxes"
          onAction={() => active && openWorkspace.mutate(active, { onError: failed })}
        >
          <RowBody
            lead={
              <Cluster
                faces={faces}
                size={32}
                // The ring is the fill behind the row: the menu's, or the hover highlight's.
                ring="bg-overlay in-data-fluid-hover-active:bg-accent"
              />
            }
            name="All mailboxes"
            detail={`${faces.length} ${faces.length === 1 ? "mailbox" : "mailboxes"}`}
            chosen={!shown}
          />
        </MenuItem>
        {grouped
          ? groups.map((workspace) => (
              <MenuSection
                key={workspace.id}
                label={workspace.name}
                className="mt-0"
                labelClassName={GROUP_LABEL}
              >
                {mailboxRows(workspace)}
              </MenuSection>
            ))
          : groups[0] && mailboxRows(groups[0])}
      </Menu>
    </MenuTrigger>
  );
}

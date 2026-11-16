// The mailbox switcher, Mail's row above Inbox: which mailbox the app shows, or all of them. The
// UX follows a mail app's account menu: All, then each mailbox. Only the active workspace's:
// "All" never reaches into another workspace (ADR 0014, amended: workspace isolation); the
// workspace itself is chosen at the top of the sidebar. Settings and log out live in the footer.
//
// Geometry, so the menu breathes and balances optically:
// - Every row is 50px: a 32px avatar beside a 34px two-line block (13/16 name, 2px, 11/16
//   address), nothing clipped. Each mark is even inside its own corner of the row: the avatar
//   9px from the row's top and left, the check's ink the same distance from its top and right.
// - The menu's 8px padding puts avatars 17px from its edges.
import { CheckIcon } from "@heroicons/react/20/solid";
import { useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";
import { IconChevronsUpDown } from "@/components/icons/central";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { SidebarItemTrigger } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/toast";
import { useMember } from "@/hooks/use-session.ts";
import { useOpenMailbox, useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { WorkspaceMailbox } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";

/** Rows are 50px (8px + the 34px text block + 8px). The 32px avatar sits 9px from the row's top
 *  and left; the check's ink 20px from its top and right (measured). Each mark is even inside its
 *  own corner. */
const ROW = "min-h-12 rounded-sm ps-2.25 pe-4.5 py-2";
const ROW_CONTENT = "col-span-full flex min-w-0 items-center gap-3";

/** Two blank discs: the cluster's shape before any mailbox has a face. */
const BLANK_FACES: Face[] = ["a", "b"].map((key) => ({ key, name: "", image: null }));

const failed = () => appToast.error("The mailbox could not be opened. Try again.");

/** A mailbox as the switcher shows it: who it is and their picture, if any. */
interface Face {
  key: string;
  name: string;
  image: string | null;
}

/** What a mailbox is called: you, for your personal one; its local part for a shared one. */
export function mailboxName(mailbox: WorkspaceMailbox, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** A round avatar `size` px across: the picture when there is one, else the initial on a grey a
 *  half step darker than the hover highlight, so a face without a picture still stands out. Multiply:
 *  under the row's hover highlight the fill darkens with it instead of sitting on top. */
function FaceAvatar(props: { face: Face; size: number }) {
  return (
    <Avatar
      src={props.face.image}
      initials={props.face.name.slice(0, 1).toUpperCase() || undefined}
      className="bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-accent))] text-foreground outline-0 mix-blend-multiply"
      style={{ "--avatar-size": `${props.size}px` } as CSSProperties}
    />
  );
}

/** Where each disc sits in a `size` square, by how many there are, and how wide each is. */
function clusterLayout(count: number, size: number) {
  if (count <= 1) return [{ x: 0, y: 0, d: size }];
  if (count === 2) {
    // Two on the diagonal, top left behind bottom right, each well over half the square.
    const d = size * 0.62;
    return [
      { x: 0, y: 0, d },
      { x: size - d, y: size - d, d },
    ];
  }
  // Three equal discs on an even triangle: every pair of centres the same distance apart, a
  // hair under one disc's width, so every ring between them is the same hairline. The triangle
  // spans the square's width and sits centred in its height.
  const d = size / 1.88;
  const side = d * 0.88;
  const top = (size - (side * Math.sqrt(3)) / 2 - d) / 2;
  return [
    { x: 0, y: top, d },
    { x: side, y: top, d },
    { x: side / 2, y: top + (side * Math.sqrt(3)) / 2, d },
  ];
}

/**
 * "All mailboxes": the mailboxes' own avatars in one avatar's square. One fills it; two sit on
 * the diagonal; with three or more, the first two sit on top and "+N" (the rest) below between them,
 * all three the same size. A ring in the fill behind them (`ring`) keeps a hairline between neighbours on the menu,
 * under the hover highlight and on the trigger.
 */
function Cluster(props: { faces: Face[]; size: number; ring: string }) {
  const { faces, size } = props;
  const shown: (Face | { more: number })[] =
    faces.length > 2 ? [...faces.slice(0, 2), { more: faces.length - 2 }] : faces;
  const spots = clusterLayout(shown.length, size);
  return (
    <span aria-hidden className="relative block shrink-0" style={{ width: size, height: size }}>
      {shown.map((item, i) => {
        const spot = spots[i] ?? { x: 0, y: 0, d: size };
        return (
          <span
            key={"more" in item ? "more" : item.key}
            className={cn("absolute flex rounded-full p-[1.5px]", props.ring)}
            style={{ left: spot.x - 1.5, top: spot.y - 1.5 }}
          >
            {"more" in item ? (
              <Avatar
                initials={`+${item.more}`}
                className="bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-accent))] text-foreground outline-0 mix-blend-multiply"
                style={{ "--avatar-size": `${spot.d}px` } as CSSProperties}
              />
            ) : (
              <FaceAvatar face={item} size={spot.d} />
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

  const active = workspaces.data?.workspaces.find((workspace) => workspace.id === member.orgId);
  const mailboxes = active?.mailboxes ?? [];
  const you = user.name || user.email;
  const face = (mailbox: WorkspaceMailbox): Face => ({
    key: mailbox.id,
    name: mailboxName(mailbox, you),
    image: mailbox.kind === "personal" ? pictureUrl(user.image) : null,
  });
  const shown = mailboxes.find((box) => box.id === current);
  const pending = openWorkspace.isPending || openMailbox.isPending;
  const faces = mailboxes.map(face);
  // With no mailbox yet the cluster keeps two discs, blank, so All keeps its mark.
  const clusterFaces = faces.length > 0 ? faces : BLANK_FACES;

  const triggerName = shown ? mailboxName(shown, you) : "All mailboxes";

  const mailboxRows = mailboxes.map((mailbox) => (
    <MenuItem
      key={mailbox.id}
      className={ROW}
      textValue={mailbox.address}
      onAction={() =>
        openMailbox.mutate(
          { workspaceId: member.orgId, mailboxId: mailbox.id },
          { onError: failed },
        )
      }
    >
      <RowBody
        lead={<FaceAvatar face={face(mailbox)} size={32} />}
        name={mailboxName(mailbox, you)}
        detail={mailbox.address}
        chosen={mailbox.id === current}
      />
    </MenuItem>
  ));

  return (
    <MenuTrigger>
      {/* A sidebar row like the ones under it: the mark in the nav icons' 15px box, the label
          10px after it, the chevron at the row's end. */}
      <SidebarItemTrigger aria-label={`Switch mailbox, currently ${triggerName}`}>
        <span className="grid size-icon shrink-0 place-items-center">
          {pending ? (
            <Loader className="size-icon text-muted-foreground" />
          ) : shown ? (
            // 18px over the 15px box: the margin centres it on the nav icons' axis.
            <span className="-m-[1.5px]">
              <FaceAvatar face={face(shown)} size={18} />
            </span>
          ) : (
            // 20px over the 15px box, centred on the same axis.
            <span className="-m-[2.5px]">
              <Cluster
                faces={clusterFaces}
                size={20}
                ring="bg-sidebar group-hover/sidebar-item:bg-sidebar-accent group-aria-expanded/sidebar-item:bg-sidebar-accent"
              />
            </span>
          )}
        </span>
        <span className="min-w-0 truncate">{triggerName}</span>
        <IconChevronsUpDown className="ms-auto size-3.5 shrink-0 text-subtle-foreground" />
      </SidebarItemTrigger>

      <Menu
        placement="bottom start"
        popover={{
          offset: 4,
          // The row sits 8px from the window's edge: keep the same 8px, so the menu's left
          // edge lines up with the row's instead of being pushed in to the usual 16px.
          collisionPadding: 8,
          // Rows carry an avatar and two lines: at least 288px, growing to 384px for long
          // addresses (they truncate past it).
          className:
            "min-w-72 max-w-[min(24rem,calc(100vw-16px))] [--popover-radius:var(--radius-xl)]",
        }}
        className="p-2"
      >
        {/* All of the active workspace's mailboxes, above each one. */}
        <MenuItem
          className={ROW}
          textValue="All mailboxes"
          onAction={() => active && openWorkspace.mutate(active, { onError: failed })}
        >
          <RowBody
            lead={
              <Cluster
                faces={clusterFaces}
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
        {mailboxRows}
      </Menu>
    </MenuTrigger>
  );
}

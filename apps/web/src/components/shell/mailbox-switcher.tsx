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

const ROW = "min-h-12 rounded-sm ps-2.25 pe-4.5 py-2";
const ROW_CONTENT = "col-span-full flex min-w-0 items-center gap-3";

const BLANK_FACES: Face[] = ["a", "b"].map((key) => ({ key, name: "", image: null }));

const failed = () => appToast.error("The mailbox could not be opened. Try again.");

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

function clusterLayout(count: number, size: number) {
  if (count <= 1) return [{ x: 0, y: 0, d: size }];
  if (count === 2) {
    const d = size * 0.62;
    return [
      { x: 0, y: 0, d },
      { x: size - d, y: size - d, d },
    ];
  }
  const d = size / 1.88;
  const side = d * 0.88;
  const top = (size - (side * Math.sqrt(3)) / 2 - d) / 2;
  return [
    { x: 0, y: top, d },
    { x: side, y: top, d },
    { x: side / 2, y: top + (side * Math.sqrt(3)) / 2, d },
  ];
}

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
  const face = (mailbox: WorkspaceMailbox) =>
    ({
      key: mailbox.id,
      name: mailboxName(mailbox, you),
      image: mailbox.kind === "personal" ? pictureUrl(user.image) : null,
    }) satisfies Face;
  const shown = mailboxes.find((box) => box.id === current);
  const pending = openWorkspace.isPending || openMailbox.isPending;
  const faces = mailboxes.map(face);
  const clusterFaces = faces.length > 0 ? faces : BLANK_FACES;
  const single = shown ? face(shown) : clusterFaces.length === 1 ? clusterFaces[0] : undefined;

  const triggerName = shown ? mailboxName(shown, you) : "All mailboxes";

  const mailboxRows = mailboxes.map((mailbox) => (
    <MenuItem
      key={mailbox.id}
      className={ROW}
      textValue={mailbox.address}
      onAction={() =>
        active &&
        openMailbox.mutate({ workspace: active, mailboxId: mailbox.id }, { onError: failed })
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
      <SidebarItemTrigger aria-label={`Switch mailbox, currently ${triggerName}`}>
        <span className="grid size-icon shrink-0 place-items-center">
          {pending ? (
            <Loader className="size-icon text-muted-foreground" />
          ) : single ? (
            <span className="-m-[1.5px]">
              <FaceAvatar face={single} size={18} />
            </span>
          ) : (
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
        <IconChevronsUpDown className="ms-auto -me-0.75 size-3.5 shrink-0 text-subtle-foreground group-hover/sidebar-item:text-foreground group-aria-expanded/sidebar-item:text-foreground" />
      </SidebarItemTrigger>

      <Menu
        placement="bottom start"
        popover={{
          offset: 4,
          collisionPadding: 8,
          className:
            "min-w-72 max-w-[min(24rem,calc(100vw-16px))] [--popover-radius:var(--radius-xl)]",
        }}
        className="p-2"
      >
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

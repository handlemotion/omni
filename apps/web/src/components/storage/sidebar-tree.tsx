import { fileType } from "@omni/client";
import { useSearch } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useDrop } from "react-aria-components/useDrop";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useSidebarExpanded } from "@/hooks/use-sidebar-expanded.ts";
import { useStorageList } from "@/hooks/use-storage.ts";
import {
  driveKey,
  driveOf,
  type DriveRoot,
  type StorageNode,
  type StoragePlace,
} from "@/lib/storage.ts";
import { useSeen } from "./file-card.tsx";
import { FileGlyph, LineGlyph } from "./file-glyph.tsx";
import { GAP_MS, useDriveDrag } from "./drive-drag-state.ts";
import {
  GAP,
  dropOperation,
  placeKey,
  useDropInto,
  useGapAt,
  useNodeDrag,
  type DragSource,
  type DropData,
  type DropPlace,
} from "./node-drag.tsx";
import { useDriveRowMenu, useFolderRowMenu } from "./sidebar-menus.tsx";
import { drivePath } from "./storage-nav.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

const SHOWN = 100;

type Expand = { value: boolean; toggle: () => void };

/**
 * A drive in the sidebar: its name as a small header (it opens the drive's top), then everything
 * in it, folders and files, as a tree. Its contents load once the header comes near the screen: a
 * workspace with a space per deal has hundreds, and reading each one's listing at once held the
 * sidebar, and every screen beside it, for seconds.
 */
export function SidebarGroup(props: { drive: DriveRoot; label: string; search: string }) {
  const { drive } = props;
  const key = driveKey(drive);
  const closed = useSidebarExpanded("drive-groups-closed", key);
  const open = { value: !closed.value, toggle: closed.toggle };
  const path = drivePath(drive);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key
  const to = useMemo<DropPlace>(() => ({ place: drive, canWrite: true }), [key]);
  const menu = useDriveRowMenu(drive, path, open);
  const section = useRef<HTMLDivElement>(null);
  const seen = useSeen(section);
  return (
    <SidebarSection ref={section}>
      {menu.dialogs}
      <DragRow to={to} expand={open} menu={menu.props}>
        <SidebarTreeRow heading depth={0} isCurrent={false} label={props.label} expand={open} />
      </DragRow>
      {open.value && seen && (
        <Level place={drive} drive={drive} depth={0} ancestors={[]} search={props.search} />
      )}
    </SidebarSection>
  );
}

function Level(props: {
  place: StoragePlace;
  drive: DriveRoot;
  depth: number;
  ancestors: string[];
  search: string;
}) {
  const list = useStorageList(props.place);
  const shown = list.nodes.slice(0, SHOWN);
  const pending = list.isPending ? null : props.place;
  const folderGap = useGapAt(pending, shown, "folder");
  const fileGap = useGapAt(pending, shown, "file");
  const gap = folderGap ?? fileGap;
  if (list.isPending) return <SidebarTreeBones depth={props.depth} />;
  return (
    <WithGap
      gap={gap}
      rows={shown.map((node) =>
        node.kind === "folder" ? (
          <Folder
            key={node.id}
            node={node}
            depth={props.depth}
            ancestors={props.ancestors}
            search={props.search}
          />
        ) : (
          <FileRow
            key={node.id}
            node={node}
            depth={props.depth}
            ancestors={props.ancestors}
            search={props.search}
          />
        ),
      )}
    />
  );
}

function Folder(props: { node: StorageNode; depth: number; ancestors: string[]; search: string }) {
  const open = useSidebarExpanded("drive", props.node.id);
  const list = useStorageList({ parentId: props.node.id }, { enabled: open.value });
  const empty = !list.isPending && list.nodes.length === 0;
  return (
    <>
      <FolderRow {...props} expand={empty ? undefined : open} />
      {open.value && !empty && (
        <Level
          place={{ parentId: props.node.id }}
          drive={driveOf(props.node)}
          depth={props.depth + 1}
          ancestors={[...props.ancestors, props.node.id]}
          search={props.search}
        />
      )}
    </>
  );
}

const parentPlace = (drive: DriveRoot, ancestors: string[]) => {
  const parent = ancestors.at(-1);
  const place: StoragePlace = parent ? { parentId: parent } : drive;
  return place;
};

function FolderRow(props: {
  node: StorageNode;
  depth: number;
  ancestors: string[];
  search: string;
  expand: Expand | undefined;
}) {
  const { node, ancestors } = props;
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const file = useSearch({ strict: false, select: (search) => (search as { file?: string }).file });
  const drive = driveOf(node);
  const href = `${drivePath(drive)}/${encodeURIComponent(node.id)}`;
  const key = driveKey(drive);
  const chain = ancestors.join("/");
  const to = useMemo<DropPlace>(
    () => ({
      place: { parentId: node.id },
      drive,
      canWrite: true,
      within: ancestors.length > 0 ? ancestors : undefined,
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key, the chain its ancestors
    [node.id, key, chain],
  );
  const beside = useMemo<DropPlace>(
    () => ({ place: parentPlace(drive, ancestors), drive, canWrite: true }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key, the chain its ancestors
    [key, chain],
  );
  const menu = useFolderRowMenu(node, href, props.expand);
  return (
    <>
      {menu.dialogs}
      <DragRow to={to} beside={beside} node={node} expand={props.expand} menu={menu.props}>
        <SidebarTreeRow
          href={inWorkspace(href + props.search)}
          isCurrent={pathname === href && !file}
          depth={props.depth}
          icon={<FileGlyph kind="folder" className="size-icon" />}
          label={node.name}
          {...(props.expand ? { expand: props.expand } : {})}
          onPress={() => props.expand && !props.expand.value && props.expand.toggle()}
        />
      </DragRow>
    </>
  );
}

function FileRow(props: { node: StorageNode; depth: number; ancestors: string[]; search: string }) {
  const { node, ancestors } = props;
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const file = useSearch({ strict: false, select: (search) => (search as { file?: string }).file });
  const drive = driveOf(node);
  const key = driveKey(drive);
  const parent = ancestors.at(-1);
  const folder = `${drivePath(drive)}${parent ? `/${encodeURIComponent(parent)}` : ""}`;
  const query = props.search ? `${props.search}&` : "?";
  const to = useMemo<DropPlace>(
    () => ({ place: parentPlace(drive, ancestors), drive, canWrite: true }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key, the chain its ancestors
    [key, ancestors.join("/")],
  );
  const menu = useMemo(() => ({ onContextMenu: () => undefined }), []);
  return (
    <DragRow to={to} node={node} menu={menu}>
      <SidebarTreeRow
        href={inWorkspace(`${folder}${query}file=${encodeURIComponent(node.id)}`)}
        isCurrent={pathname === folder && file === node.id}
        depth={props.depth}
        icon={<LineGlyph kind={fileType(node.name, node.mimeType).kind} className="size-icon" />}
        label={node.name}
      />
    </DragRow>
  );
}

const DROP_TARGET =
  "data-drop-target:**:data-[slot=sidebar-item]:bg-primary/10 data-drive-target:**:data-[slot=sidebar-item]:bg-primary/10 data-drive-target:**:data-[slot=sidebar-item]:inset-ring data-drive-target:**:data-[slot=sidebar-item]:inset-ring-primary";

const LIFTED =
  "data-lifted:**:data-[slot=sidebar-item]:bg-transparent! data-lifted:**:data-[slot=sidebar-item]:*:invisible data-lifted:**:[button]:invisible data-[lifted=origin]:**:data-[slot=sidebar-item]:outline-1 data-[lifted=origin]:**:data-[slot=sidebar-item]:-outline-offset-1 data-[lifted=origin]:**:data-[slot=sidebar-item]:outline-dashed data-[lifted=origin]:**:data-[slot=sidebar-item]:outline-border";

const OPEN_AFTER_MS = 600;

function DragRow(props: {
  to: DropPlace;
  beside?: DropPlace | undefined;
  node?: StorageNode;
  expand?: { value: boolean; toggle: () => void } | undefined;
  menu: { onContextMenu: (event: MouseEvent) => void };
  children: ReactNode;
}) {
  const { to, beside, node, expand } = props;
  const ref = useRef<HTMLDivElement>(null);
  const into = useDropInto();
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: () => dropOperation(to),
    onDrop: (event) => void into(to, event.items),
    onDropActivate: () => expand && !expand.value && expand.toggle(),
  });
  const source = useMemo<DragSource | null>(() => (node ? { node, look: "tree" } : null), [node]);
  const drop = useMemo<DropData>(() => ({ to, folder: true, beside }), [to, beside]);
  const lift = useNodeDrag(
    node ? `tree:node:${node.id}` : `tree:${placeKey(to.place)}`,
    source,
    drop,
  );
  const held = lift.props["data-drive-target"] === true;
  const closed = !!expand && !expand.value;
  const open = useEffectEvent(() => expand && !expand.value && expand.toggle());
  useEffect(() => {
    if (!held || !closed) return;
    const timer = setTimeout(open, OPEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [held, closed]);
  const { "aria-describedby": _described, ...rowDropProps } = dropProps;
  const { onPointerDown, ...liftProps } = lift.props;
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      ref.current = element;
      lift.ref(element);
    },
    [lift.ref],
  );
  return (
    <div
      ref={setRef}
      {...rowDropProps}
      {...liftProps}
      onPointerDownCapture={onPointerDown}
      onContextMenu={props.menu.onContextMenu}
      data-drop-target={isDropTarget || undefined}
      className={`${DROP_TARGET} ${LIFTED}`}
    >
      {props.children}
    </div>
  );
}

function TreeGap() {
  const { phase } = useDriveDrag();
  const reduce = useReducedMotion();
  const instant = reduce || phase !== "origin";
  return (
    <motion.div
      data-drive-gap
      initial={{ height: instant ? 32 : 0 }}
      animate={{ height: 32 }}
      exit={{ height: 0 }}
      transition={instant ? { duration: 0 } : { duration: GAP_MS / 1000, ease: "easeOut" }}
      className="overflow-hidden"
    >
      <div className={`h-8 ${GAP}`} />
    </motion.div>
  );
}

function WithGap(props: { gap: number | null; rows: ReactNode[] }) {
  const rows = [...props.rows];
  if (props.gap !== null) rows.splice(props.gap, 0, <TreeGap key="drive-drag-gap" />);
  return <AnimatePresence initial={false}>{rows}</AnimatePresence>;
}

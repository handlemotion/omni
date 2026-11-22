import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, type ReactNode } from "react";
import { useDrop } from "react-aria-components/useDrop";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useSidebarExpanded } from "@/hooks/use-sidebar-expanded.ts";
import { useFolderIcons, useStorageList } from "@/hooks/use-storage.ts";
import { driveKey, driveOf, type DriveRoot, type StorageNode } from "@/lib/storage.ts";
import { FolderIcon } from "./folder-icons.tsx";
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
import { drivePath } from "./storage-nav.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

const SHOWN = 40;

/** A drive's group in the sidebar: its top, then its folders. */
export function SidebarGroup(props: {
  drive: DriveRoot;
  label: string;
  icon: ReactNode;
  search: string;
}) {
  const { drive } = props;
  const key = driveKey(drive);
  const closed = useSidebarExpanded("drive-groups-closed", key);
  const open = { value: !closed.value, toggle: closed.toggle };
  const { place: pathname, href } = useWorkspacePaths();
  const path = drivePath(drive);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key
  const to = useMemo<DropPlace>(() => ({ place: drive, canWrite: true }), [key]);
  return (
    <SidebarSection className="pb-1">
      <DragRow to={to} expand={open}>
        <SidebarTreeRow
          href={href(path + props.search)}
          isCurrent={pathname === path}
          depth={0}
          icon={props.icon}
          label={props.label}
          expand={open}
          onPress={() => !open.value && open.toggle()}
        />
      </DragRow>
      {open.value && <Clusters drive={drive} search={props.search} />}
    </SidebarSection>
  );
}

function Clusters(props: { drive: DriveRoot; search: string }) {
  const root = useStorageList(props.drive);
  const { icons } = useFolderIcons(props.drive);
  const shown = folders(root.nodes);
  const gap = useGapAt(root.isPending ? null : props.drive, shown, "folder");
  if (root.isPending) return <SidebarTreeBones depth={1} />;
  return (
    <WithGap
      gap={gap}
      rows={shown.map((node) => (
        <Cluster key={node.id} node={node} icon={icons[node.id]} search={props.search} />
      ))}
    />
  );
}

function Cluster(props: { node: StorageNode; icon: string | undefined; search: string }) {
  const open = useSidebarExpanded("drive", props.node.id);
  const list = useStorageList({ parentId: props.node.id });
  const hasFolders = list.isPending || list.nodes.some((node) => node.kind === "folder");
  return (
    <>
      <FolderRow
        node={props.node}
        icon={props.icon}
        depth={1}
        search={props.search}
        expand={hasFolders ? open : undefined}
      />
      {hasFolders && open.value && <ClusterFolders node={props.node} search={props.search} />}
    </>
  );
}

function ClusterFolders(props: { node: StorageNode; search: string }) {
  const list = useStorageList({ parentId: props.node.id });
  const shown = folders(list.nodes);
  const gap = useGapAt(list.isPending ? null : { parentId: props.node.id }, shown, "folder");
  if (list.isPending) return <SidebarTreeBones depth={2} />;
  return (
    <WithGap
      gap={gap}
      rows={shown.map((node) => (
        <FolderRow key={node.id} node={node} depth={2} search={props.search} cluster={props.node} />
      ))}
    />
  );
}

function FolderRow(props: {
  node: StorageNode;
  icon?: string | undefined;
  depth: number;
  search: string;
  expand?: { value: boolean; toggle: () => void } | undefined;
  cluster?: StorageNode;
}) {
  const { node, cluster } = props;
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const drive = driveOf(node);
  const href = `${drivePath(drive)}/${encodeURIComponent(node.id)}`;
  const key = driveKey(drive);
  const to = useMemo<DropPlace>(
    () => ({
      place: { parentId: node.id },
      drive,
      canWrite: true,
      within: cluster ? [cluster.id] : undefined,
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key
    [node.id, key, cluster],
  );
  const beside = useMemo<DropPlace>(
    () =>
      cluster
        ? { place: { parentId: cluster.id }, drive, canWrite: true }
        : { place: drive, canWrite: true },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the drive is its key
    [cluster, key],
  );
  return (
    <DragRow to={to} beside={beside} node={node} expand={props.expand}>
      <SidebarTreeRow
        href={inWorkspace(href + props.search)}
        isCurrent={pathname === href}
        depth={props.depth}
        icon={<FolderIcon icon={props.icon} className="size-icon" />}
        label={node.name}
        {...(props.expand ? { expand: props.expand } : {})}
        onPress={() => props.expand && !props.expand.value && props.expand.toggle()}
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
  const lift = useNodeDrag(`tree:${placeKey(to.place)}`, source, drop);
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

const folders = (nodes: StorageNode[]) =>
  nodes.filter((node) => node.kind === "folder").slice(0, SHOWN);

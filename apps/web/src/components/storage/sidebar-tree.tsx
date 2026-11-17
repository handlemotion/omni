// Storage's folder groups below its places, after Skiff Drive's: a group (Team, Personal) links
// to its space and opens to its clusters, the space's top-level folders; a cluster opens to the
// folders inside it, and the sidebar stops there. Deeper folders and files are on the pages.
// Groups start open; clusters start closed (their contents load the first time).
//
// Every row takes a drop (`node-drag.tsx`): files and folders dragged from the page, or another
// row, move into it, and files from the computer upload there. Held over a closed row, a drag
// opens it. Clusters and their folders drag too; the groups are the spaces themselves and stay.
import { useLayoutEffect, useRef, type DragEvent, type ReactNode } from "react";
import { useDrag } from "react-aria-components/useDrag";
import { useDrop } from "react-aria-components/useDrop";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useSidebarExpanded } from "@/hooks/use-sidebar-expanded.ts";
import { useFolderIcons, useStorageList } from "@/hooks/use-storage.ts";
import type { StorageNode, StorageSpace } from "@/lib/storage.ts";
import { FolderIcon } from "./folder-icons.tsx";
import {
  dragItems,
  draggedOf,
  dropOperation,
  endDrag,
  startDrag,
  useDropInto,
  type DropPlace,
} from "./node-drag.tsx";
import { SPACE_ICON, SPACE_LABEL, SPACE_PATH } from "./storage-nav.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

/** A level shows this many folders; the folder's page has the rest. */
const SHOWN = 40;

export function SidebarGroup(props: { space: StorageSpace; search: string }) {
  const { space } = props;
  // Stored as closed, so a group nobody has touched is open.
  const closed = useSidebarExpanded("drive-groups-closed", space);
  const open = { value: !closed.value, toggle: closed.toggle };
  const { place: pathname, href } = useWorkspacePaths();
  return (
    // 4px under a group's last row, so Team and Personal read as two groups.
    <SidebarSection className="pb-1">
      <DragRow to={{ place: { space }, canWrite: true }} expand={open}>
        <SidebarTreeRow
          href={href(SPACE_PATH[space] + props.search)}
          isCurrent={pathname === SPACE_PATH[space]}
          depth={0}
          icon={SPACE_ICON[space]}
          label={SPACE_LABEL[space]}
          expand={open}
          onPress={() => !open.value && open.toggle()}
        />
      </DragRow>
      {open.value && <Clusters space={space} search={props.search} />}
    </SidebarSection>
  );
}

function Clusters(props: { space: StorageSpace; search: string }) {
  const root = useStorageList({ space: props.space });
  const { icons } = useFolderIcons(props.space);
  if (root.isPending) return <SidebarTreeBones depth={1} />;
  return folders(root.nodes).map((node) => (
    <Cluster key={node.id} node={node} icon={icons[node.id]} search={props.search} />
  ));
}

function Cluster(props: { node: StorageNode; icon: string | undefined; search: string }) {
  const open = useSidebarExpanded("drive", props.node.id);
  return (
    <>
      <FolderRow
        node={props.node}
        icon={props.icon}
        depth={1}
        search={props.search}
        expand={open}
      />
      {open.value && <ClusterFolders node={props.node} search={props.search} />}
    </>
  );
}

function ClusterFolders(props: { node: StorageNode; search: string }) {
  const list = useStorageList({ parentId: props.node.id });
  if (list.isPending) return <SidebarTreeBones depth={2} />;
  return folders(list.nodes).map((node) => (
    <FolderRow key={node.id} node={node} depth={2} search={props.search} within={[props.node.id]} />
  ));
}

function FolderRow(props: {
  node: StorageNode;
  /** A cluster's chosen glyph; a folder inside one has none. */
  icon?: string | undefined;
  depth: number;
  search: string;
  expand?: { value: boolean; toggle: () => void };
  /** The cluster a folder is in. */
  within?: string[];
}) {
  const { node } = props;
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const href = `${SPACE_PATH[node.space]}/${encodeURIComponent(node.id)}`;
  return (
    <DragRow
      to={{ place: { parentId: node.id }, space: node.space, canWrite: true, within: props.within }}
      node={node}
      expand={props.expand}
    >
      <SidebarTreeRow
        href={inWorkspace(href + props.search)}
        isCurrent={pathname === href}
        depth={props.depth}
        icon={<FolderIcon icon={props.icon} className="size-icon" />}
        label={node.name}
        {...(props.expand ? { expand: props.expand } : {})}
        // Opening a cluster's page opens it in the tree too; only the chevron closes it.
        onPress={() => props.expand && !props.expand.value && props.expand.toggle()}
      />
    </DragRow>
  );
}

/** A row the drop zone's tint marks while a drag held over it would drop there. */
const DROP_TARGET = "data-drop-target:**:data-[slot=sidebar-item]:bg-primary/10";

/**
 * A row as a drop target for its folder or space, and (given `node`) a drag source. The row's
 * own link would drag its address: the whole row drags instead, as the picture under the pointer.
 * A pointer's drag lands on the row; a keyboard or screen reader drag moves focus between drop
 * targets, so the row's link (focusable, a role) is the target React Aria registers for those.
 */
function DragRow(props: {
  to: DropPlace;
  node?: StorageNode;
  expand?: { value: boolean; toggle: () => void } | undefined;
  children: ReactNode;
}) {
  const { to, node, expand } = props;
  const ref = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLElement>(null);
  // Before `useDrop`'s own layout effect, which registers `link.current`.
  useLayoutEffect(() => {
    link.current = ref.current?.querySelector<HTMLElement>("[data-slot=sidebar-item]") ?? null;
  });
  const into = useDropInto();
  const { dropProps, isDropTarget } = useDrop({
    ref: link,
    getDropOperation: () => dropOperation(to),
    onDrop: (event) => void into(to, event.items),
    onDropActivate: () => expand && !expand.value && expand.toggle(),
  });
  const dragged = node ? [draggedOf(node, undefined)] : [];
  const { dragProps } = useDrag({
    isDisabled: !node,
    getItems: () => dragItems(dragged),
    getAllowedDropOperations: () => ["move"],
    onDragStart: () => startDrag(dragged),
    onDragEnd: endDrag,
  });
  const { "aria-describedby": described, ...rowDropProps } = dropProps;
  // What a keyboard drag's target says it does, on the link that takes focus, beside what the
  // link is already described by (its tooltip), which comes back when the drag ends.
  useLayoutEffect(() => {
    const element = link.current;
    const own = element?.getAttribute("aria-describedby");
    if (!element || !described) return;
    element.setAttribute("aria-describedby", own ? `${own} ${described}` : described);
    return () => {
      if (own) element.setAttribute("aria-describedby", own);
      else element.removeAttribute("aria-describedby");
    };
  }, [described]);
  return (
    <div
      ref={ref}
      {...rowDropProps}
      {...dragProps}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        dragProps.onDragStart?.(event);
        const row = ref.current;
        if (!row) return;
        const box = row.getBoundingClientRect();
        event.dataTransfer.setDragImage(row, event.clientX - box.left, event.clientY - box.top);
      }}
      data-drop-target={isDropTarget || undefined}
      className={DROP_TARGET}
    >
      {props.children}
    </div>
  );
}

const folders = (nodes: StorageNode[]) =>
  nodes.filter((node) => node.kind === "folder").slice(0, SHOWN);

// Storage's folder groups below its places, after Skiff Drive's: a group (Team, Personal) links
// to its space and opens to its clusters, the space's top-level folders; a cluster opens to the
// folders inside it, and the sidebar stops there. Deeper folders and files are on the pages.
// Groups start open; clusters start closed (their contents load the first time).
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useSidebarExpanded } from "@/hooks/use-sidebar-expanded.ts";
import { useFolderIcons, useStorageList } from "@/hooks/use-storage.ts";
import type { StorageNode, StorageSpace } from "@/lib/storage.ts";
import { FolderIcon } from "./folder-icons.tsx";
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
      <SidebarTreeRow
        href={href(SPACE_PATH[space] + props.search)}
        isCurrent={pathname === SPACE_PATH[space]}
        depth={0}
        icon={SPACE_ICON[space]}
        label={SPACE_LABEL[space]}
        expand={open}
        onPress={() => !open.value && open.toggle()}
      />
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
    <FolderRow key={node.id} node={node} depth={2} search={props.search} />
  ));
}

function FolderRow(props: {
  node: StorageNode;
  /** A cluster's chosen glyph; a folder inside one has none. */
  icon?: string | undefined;
  depth: number;
  search: string;
  expand?: { value: boolean; toggle: () => void };
}) {
  const { node } = props;
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const href = `${SPACE_PATH[node.space]}/${encodeURIComponent(node.id)}`;
  return (
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
  );
}

const folders = (nodes: StorageNode[]) =>
  nodes.filter((node) => node.kind === "folder").slice(0, SHOWN);

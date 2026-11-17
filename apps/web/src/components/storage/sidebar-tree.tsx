// Storage's sidebar below its places, after Skiff Drive's: a space's folders as a tree in the
// sidebar's own rows. A folder links to its page and opens in place as it does (its contents load
// the first time); its chevron opens and closes it without leaving the page. A file inside links
// to its folder with the file open in the preview.
import { useLocation } from "@tanstack/react-router";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useSidebarExpanded } from "@/hooks/use-sidebar-expanded.ts";
import { useStorageList } from "@/hooks/use-storage.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode, StorageSpace } from "@/lib/storage.ts";
import { FileGlyph } from "./file-glyph.tsx";
import { SPACE_PATH } from "./storage-nav.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

/** A level shows this many items; the folder's page has the rest. */
const SHOWN = 40;

export function SidebarTree(props: { space: StorageSpace; label: string; search: string }) {
  const root = useStorageList({ space: props.space });
  const folders = root.nodes.filter((node) => node.kind === "folder");
  if (!root.isPending && folders.length === 0) return null;
  return (
    <SidebarSection label={props.label}>
      {root.isPending ? (
        <SidebarTreeBones depth={0} />
      ) : (
        folders
          .slice(0, SHOWN)
          .map((node) => <Folder key={node.id} node={node} depth={0} search={props.search} />)
      )}
    </SidebarSection>
  );
}

function Folder(props: { node: StorageNode; depth: number; search: string }) {
  const { node, depth } = props;
  const open = useSidebarExpanded("drive", node.id);
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const href = `${SPACE_PATH[node.space]}/${encodeURIComponent(node.id)}`;
  return (
    <>
      <SidebarTreeRow
        href={inWorkspace(href + props.search)}
        isCurrent={pathname === href}
        depth={depth}
        icon={<FileGlyph kind="folder" className="size-icon" />}
        label={node.name}
        expand={open}
        // Going to a folder shows what is in it; closing it is the chevron's job.
        onPress={() => !open.value && open.toggle()}
      />
      {open.value && <Contents node={node} depth={depth + 1} search={props.search} />}
    </>
  );
}

/** An open folder's folders, then its files. */
function Contents(props: { node: StorageNode; depth: number; search: string }) {
  const list = useStorageList({ parentId: props.node.id });
  if (list.isPending) return <SidebarTreeBones depth={props.depth} />;
  return list.nodes
    .slice(0, SHOWN)
    .map((node) =>
      node.kind === "folder" ? (
        <Folder key={node.id} node={node} depth={props.depth} search={props.search} />
      ) : (
        <File key={node.id} node={node} depth={props.depth} search={props.search} />
      ),
    );
}

function File(props: { node: StorageNode; depth: number; search: string }) {
  const { node } = props;
  const { searchStr } = useLocation();
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const folder = `${SPACE_PATH[node.space]}${node.parentId ? `/${encodeURIComponent(node.parentId)}` : ""}`;
  const query = new URLSearchParams(props.search);
  query.set("file", node.id);
  return (
    <SidebarTreeRow
      href={inWorkspace(`${folder}?${query}`)}
      isCurrent={pathname === folder && new URLSearchParams(searchStr).get("file") === node.id}
      depth={props.depth}
      icon={<FileGlyph kind={fileType(node.name, node.mimeType).kind} className="size-icon" />}
      label={node.name}
    />
  );
}

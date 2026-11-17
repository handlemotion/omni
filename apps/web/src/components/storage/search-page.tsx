// Drive's Search: files and folders across Team and Personal at once, in the folder page's
// sections (Folders, then Files, as floating rows or cards). A folder opens its page; a file
// opens in its own folder's preview.
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconDownload, IconFolder } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Heading } from "@/components/ui/heading";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { useListSearch } from "@/hooks/use-list-search.ts";
import { useStorageSearch } from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { useStorageHref } from "./file-list.tsx";
import { FileSections, FileSectionsBones } from "./file-sections.tsx";
import type { NodeDrag } from "./node-drag.tsx";
import { NodeMenu } from "./node-menu.tsx";
import { StorageFrame } from "./storage-frame.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";

const fileUrl = (node: StorageNode) => storageFileUrl(node.id);

export function SearchPage({ q }: { q: string }) {
  const search = useListSearch(q);
  return (
    <StorageFrame
      title={<Heading className="truncate text-md">Search</Heading>}
      actions={
        <SearchField
          aria-label="Search files"
          value={search.text}
          onChange={search.setText}
          autoFocus
          className="w-40 sm:w-56"
        >
          <SearchInput size="sm" />
        </SearchField>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q ? (
          <Results q={q} />
        ) : (
          <div className="flex h-full flex-col">
            <EmptyState figure="loupe" title="Search files and folders" />
          </div>
        )}
      </div>
      <UploadsPanel />
    </StorageFrame>
  );
}

function Results({ q }: { q: string }) {
  const found = useStorageSearch(q);
  const href = useNodeHref();
  const menu = useMenu(href);
  const navigate = useNavigate();
  const nodes = found.nodes;
  // Picking a file opens it in its folder's preview.
  const open = useMemo(
    () => ({
      id: undefined,
      onChange: (id: string | null) => {
        const node = id ? nodes.find((n) => n.id === id) : undefined;
        if (node) void navigate({ href: href(node) });
      },
    }),
    [nodes, navigate, href],
  );
  if (found.isPending) {
    return (
      <Skeleton loading label="Searching" skeleton={<FileSectionsBones />}>
        {null}
      </Skeleton>
    );
  }
  if (found.isError) {
    return (
      <div className="flex h-full flex-col">
        <ListFailed retry={() => void found.refetch()} />
      </div>
    );
  }
  if (!nodes.length) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState figure="loupe" title="No matches" />
      </div>
    );
  }
  return (
    <NodeMenu nodes={nodes} menu={menu}>
      <FileSections
        label="Search"
        nodes={nodes}
        href={href}
        fileUrl={fileUrl}
        open={open}
        menu={menu}
        drag={SEARCH_DRAG}
      />
    </NodeMenu>
  );
}

/** Results drag onto a folder among them or in the sidebar; Search is no folder to drop into. */
const SEARCH_DRAG: NodeDrag = { door: { canWrite: true }, here: null };

/** A folder's page; a file in its folder, open in the preview (`?file=`). */
function useNodeHref() {
  const storageHref = useStorageHref();
  return useCallback(
    (node: StorageNode) => {
      if (node.kind === "folder") return storageHref(node.space, node.id);
      const folder = storageHref(node.space, node.parentId ?? undefined);
      return `${folder}${folder.includes("?") ? "&" : "?"}file=${encodeURIComponent(node.id)}`;
    },
    [storageHref],
  );
}

function useMenu(href: (node: StorageNode) => string) {
  const navigate = useNavigate();
  return useCallback(
    (node: StorageNode): SettingsRowMenuItem[] =>
      node.kind === "file"
        ? [
            {
              icon: IconDownload,
              label: "Download",
              onAction: () => window.location.assign(fileUrl(node)),
            },
          ]
        : [
            {
              icon: IconFolder,
              label: "Open",
              onAction: () => void navigate({ href: href(node) }),
            },
          ],
    [navigate, href],
  );
}

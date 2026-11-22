import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { Skeleton } from "skullet/react";
import { IconArrowUpRight, IconDownload, IconFolder } from "@/components/icons/central";
import { EmptyState } from "@/components/empty/empty-state";
import { ListFailed } from "@/components/inbox/thread-list";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Heading } from "@/components/ui/heading";
import { useSharedWithMe } from "@/hooks/use-storage.ts";
import { driveOf, type StorageNode } from "@/lib/storage.ts";
import { storageRecentQuery } from "@/lib/storage-find.ts";
import { isDoc } from "./editor/document-editor.tsx";
import { FileSections, FileSectionsBones, ViewToggle } from "./file-sections.tsx";
import { useStorageHref } from "./file-list.tsx";
import { NodeMenu } from "./node-menu.tsx";
import { StorageFrame } from "./storage-frame.tsx";
import { isOmniDoc } from "@omni/docs/file";
import { downloadFile } from "@/lib/download.ts";
import { sharedFileUrl, sharedViewUrl, storageFileUrl } from "@/lib/urls.ts";

interface Item {
  node: StorageNode;
  href: string;
  url: string;
  folderHref?: string;
}

const SHARED_PAGES = 5;

function useItems() {
  const recent = useQuery(storageRecentQuery());
  const shared = useSharedWithMe();
  const pages = shared.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = shared;
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    if (pages < SHARED_PAGES) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, pages]);
  const href = useStorageHref();
  const items = useMemo(() => {
    const own: Item[] = (recent.data ?? []).map((node) => {
      const folder = href(driveOf(node), node.parentId ?? undefined);
      return {
        node,
        folderHref: folder,
        href: `${folder}${folder.includes("?") ? "&" : "?"}file=${encodeURIComponent(node.id)}`,
        url: storageFileUrl(node.id),
      };
    });
    const theirs: Item[] = shared.items.flatMap(({ node, shareId }) =>
      shareId
        ? [
            {
              node,
              href: `/s/${encodeURIComponent(shareId)}`,
              url: isDoc(node) ? sharedViewUrl(shareId, node.id) : sharedFileUrl(shareId, node.id),
            },
          ]
        : [],
    );
    const seen = new Set(own.map((item) => item.node.id));
    return [...own, ...theirs.filter((item) => !seen.has(item.node.id))].toSorted((a, b) =>
      b.node.updatedAt.localeCompare(a.node.updatedAt),
    );
  }, [recent.data, shared.items, href]);
  return {
    items,
    isPending: recent.isPending || shared.isPending,
    isError: recent.isError || shared.isError || isFetchNextPageError,
    retry: () => {
      void recent.refetch();
      void shared.refetch();
    },
  };
}

/** The files changed most recently in the member's spaces, and what is shared with them. */
export function Recents() {
  const recents = useItems();
  return (
    <StorageFrame
      title={<Heading className="truncate text-md">Recents</Heading>}
      actions={recents.items.length ? <ViewToggle /> : undefined}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col">
          {recents.isPending ? (
            <Skeleton loading label="Loading recent files" skeleton={<FileSectionsBones />}>
              {null}
            </Skeleton>
          ) : recents.isError ? (
            <div className="flex flex-1 flex-col">
              <ListFailed retry={recents.retry} />
            </div>
          ) : !recents.items.length ? (
            <div className="flex flex-1 flex-col">
              <EmptyState figure="drawer" title="No files yet" />
            </div>
          ) : (
            <RecentItems items={recents.items} />
          )}
        </div>
      </div>
    </StorageFrame>
  );
}

function RecentItems(props: { items: Item[] }) {
  const navigate = useNavigate();
  const { items } = props;
  const byId = useMemo(() => new Map(items.map((item) => [item.node.id, item])), [items]);
  const nodes = useMemo(() => items.map((item) => item.node), [items]);
  const item = useCallback((node: StorageNode) => byId.get(node.id), [byId]);
  const href = useCallback((node: StorageNode) => item(node)?.href ?? "", [item]);
  const fileUrl = useCallback(
    (node: StorageNode) => item(node)?.url ?? storageFileUrl(node.id),
    [item],
  );
  const peek = useCallback((node: StorageNode) => !!item(node)?.folderHref, [item]);
  const menu = useCallback(
    (node: StorageNode) => {
      const found = item(node);
      if (!found) return [] satisfies SettingsRowMenuItem[];
      const { folderHref } = found;
      return [
        {
          icon: IconArrowUpRight,
          label: "Open",
          onAction: () => void navigate({ href: found.href }),
        },
        ...(folderHref
          ? [
              {
                icon: IconFolder,
                label: "Show in folder",
                onAction: () => void navigate({ href: folderHref }),
              },
            ]
          : []),
        ...(folderHref && node.kind === "file" && !isOmniDoc(node.mimeType)
          ? [
              {
                icon: IconDownload,
                label: "Download",
                onAction: () => downloadFile(storageFileUrl(node.id)),
              },
            ]
          : []),
      ] satisfies SettingsRowMenuItem[];
    },
    [item, navigate],
  );
  const open = useMemo(
    () => ({
      id: undefined,
      onChange: (id: string | null) => {
        const chosen = id === null ? undefined : byId.get(id);
        if (chosen) void navigate({ href: chosen.href });
      },
    }),
    [byId, navigate],
  );
  return (
    <NodeMenu nodes={nodes} menu={menu}>
      <FileSections
        label="Recents"
        nodes={nodes}
        href={href}
        fileUrl={fileUrl}
        peek={peek}
        open={open}
        menu={menu}
      />
    </NodeMenu>
  );
}

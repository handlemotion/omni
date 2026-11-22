import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Selection } from "react-aria-components";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { FileTile } from "@/components/storage/file-glyph";
import { SPACE_LABEL } from "@/components/storage/storage-nav.tsx";
import { Breadcrumbs, BreadcrumbsItem } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useHasSharedFiles, useStorageList, useTeamspaces } from "@/hooks/use-storage.ts";
import { linkFilesMutation, type FileRecordKind } from "@/lib/crm-files.ts";
import { fileType } from "@/lib/file-kind.ts";
import { driveKey, driveOf, type DriveRoot, type StorageNode } from "@/lib/storage.ts";
import { storageSearchQuery } from "@/lib/storage-find.ts";
import { crmErrorToast } from "./crm-errors.ts";

type At = { drive: DriveRoot; path: { id: string; name: string }[] } | null;

function useDrives() {
  const hasShared = useHasSharedFiles();
  const { teamspaces } = useTeamspaces();
  const legacy = (hasShared ? (["shared", "personal"] as const) : (["personal"] as const)).map(
    (space) => ({ drive: { space } as DriveRoot, label: SPACE_LABEL[space] }),
  );
  return [
    ...teamspaces.map((t) => ({ drive: { teamspaceId: t.id } as DriveRoot, label: t.name })),
    ...legacy,
  ];
}

function useBrowse(q: string) {
  const drives = useDrives();
  const single = drives.length === 1 ? drives[0]!.drive : null;
  const [at, setAt] = useState<At>(single ? { drive: single, path: [] } : null);
  const folder = at?.path.at(-1);
  const list = useStorageList(
    folder ? { parentId: folder.id } : (at?.drive ?? { space: "personal" }),
    {
      enabled: !!at && !q,
    },
  );
  const labelOf = (drive: DriveRoot) =>
    drives.find((each) => driveKey(each.drive) === driveKey(drive))?.label ?? "";
  const found = useQuery(storageSearchQuery(q));
  const crumbs = [
    ...(single ? [] : [{ id: "top", name: "Drive", go: () => setAt(null) }]),
    ...(at
      ? [
          {
            id: driveKey(at.drive),
            name: labelOf(at.drive),
            go: () => setAt({ ...at, path: [] }),
          },
          ...at.path.map((entry, i) => ({
            ...entry,
            go: () => setAt({ ...at, path: at.path.slice(0, i + 1) }),
          })),
        ]
      : []),
  ];
  const nodes = q ? (found.data?.nodes ?? []) : at ? list.nodes : [];
  const enter = (node: StorageNode) =>
    setAt((now) => ({
      drive: driveOf(node),
      path: [...(q || !now ? [] : now.path), { id: node.id, name: node.name }],
    }));
  return {
    at,
    crumbs,
    nodes,
    enter,
    drives,
    enterDrive: (key: string) => {
      const found = drives.find((each) => driveKey(each.drive) === key);
      if (found) setAt({ drive: found.drive, path: [] });
    },
    loadMore: !q && at && list.hasNextPage ? () => void list.fetchNextPage() : undefined,
    isLoadingMore: list.isFetchingNextPage,
  };
}

/**
 * Picks Drive files and folders to link to a company or a deal where they are (`docs/spec/crm.md`, "Keep the files"): a
 * search over the member's Drive, or browsing it a folder at a time. Opening a folder's row
 * enters it; its checkbox picks the folder itself.
 */
export function AddFromDriveDialog(props: {
  kind: FileRecordKind;
  id: string;
  name: string;
  /** Already on the record: shown, not offered again. */
  linked: Set<string>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 200);
  const browse = useBrowse(q);
  const [picked, setPicked] = useState(new Map<string, StorageNode>());
  const link = useMutation(linkFilesMutation(useQueryClient()));
  const rows = browse.nodes.filter((node) => !node.trashedAt);
  const select = (keys: Selection) => {
    const next = new Map(picked);
    for (const node of rows) next.delete(node.id);
    for (const node of rows) {
      if (keys === "all" || keys.has(node.id)) next.set(node.id, node);
    }
    setPicked(next);
  };
  const add = () =>
    link.mutate(
      { kind: props.kind, id: props.id, nodeIds: [...picked.keys()] },
      {
        onSuccess: props.onClose,
        onError: (error) => crmErrorToast(error, "The files were not added"),
      },
    );
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && !link.isPending && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">{`Add to ${props.name}`}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-2">
        <SearchField value={query} onChange={setQuery} aria-label="Search Drive" autoFocus>
          <SearchInput placeholder="Search Drive" />
        </SearchField>
        {!q && (
          <Breadcrumbs aria-label="Folder" className="min-h-5 flex-wrap gap-y-1 px-2">
            {browse.crumbs.map((crumb) => (
              <BreadcrumbsItem key={crumb.id} onPress={crumb.go}>
                {crumb.name}
              </BreadcrumbsItem>
            ))}
          </Breadcrumbs>
        )}
        {!q && !browse.at ? (
          <GridList
            aria-label="Drives"
            className="h-72 overflow-y-auto"
            onAction={(key) => browse.enterDrive(String(key))}
          >
            {browse.drives.map(({ drive, label }) => (
              <GridListItem
                key={driveKey(drive)}
                id={driveKey(drive)}
                textValue={label}
                className="h-10 shrink-0 cursor-pointer gap-2.5 rounded-lg px-2 hover:bg-accent"
              >
                <FileTile kind="folder" size="xs" />
                <span className="truncate">{label}</span>
              </GridListItem>
            ))}
          </GridList>
        ) : (
          <GridList
            aria-label="Files"
            className="h-72 overflow-y-auto"
            selectionMode="multiple"
            selectionBehavior="toggle"
            disabledKeys={[...props.linked]}
            disabledBehavior="selection"
            selectedKeys={rows.filter((node) => picked.has(node.id)).map((node) => node.id)}
            onSelectionChange={select}
            onAction={(key) => {
              const node = rows.find((n) => n.id === key);
              if (node?.kind === "folder") browse.enter(node);
              else if (node && !props.linked.has(node.id)) {
                const next = new Map(picked);
                if (next.has(node.id)) next.delete(node.id);
                else next.set(node.id, node);
                setPicked(next);
              }
            }}
            renderEmptyState={() => null}
          >
            <Collection items={rows}>
              {(node) => (
                <GridListItem
                  id={node.id}
                  textValue={node.name}
                  className="h-10 shrink-0 cursor-pointer gap-2.5 rounded-lg px-2 hover:bg-accent"
                >
                  <FileTile
                    kind={
                      node.kind === "folder" ? "folder" : fileType(node.name, node.mimeType).kind
                    }
                    size="xs"
                  />
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                </GridListItem>
              )}
            </Collection>
            <GridListLoadMoreItem onLoadMore={browse.loadMore} isLoading={browse.isLoadingMore} />
          </GridList>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogClose intent="outline" isDisabled={link.isPending}>
          Cancel
        </DialogClose>
        <Button isDisabled={picked.size === 0} isPending={link.isPending} onPress={add}>
          {picked.size > 1 ? `Add ${picked.size}` : "Add"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

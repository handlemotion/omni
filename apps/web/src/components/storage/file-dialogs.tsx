import { useState } from "react";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { IconFolder } from "@/components/icons/central";
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
import {
  useChangeNode,
  useDeleteForever,
  useHasSharedFiles,
  useStorageLink,
  useStorageList,
} from "@/hooks/use-storage.ts";
import type { StorageNode, StoragePlace, StorageSpace } from "@/lib/storage.ts";
import { eachAtMost } from "@/lib/each-at-most.ts";
import { storageErrorToast } from "./storage-errors.ts";
import { SPACE_LABEL } from "./storage-nav.tsx";

/** Asks before deleting from Trash for good; the button says what happens. */
export function DeleteForeverDialog(props: { node: StorageNode; onClose: () => void }) {
  const remove = useDeleteForever();
  return (
    <Dialog
      role="alertdialog"
      size="sm"
      isOpen
      onOpenChange={(open) => !open && !remove.isPending && props.onClose()}
    >
      <DialogHeader className="pe-0">
        <DialogTitle className="break-words">Delete “{props.node.name}” forever?</DialogTitle>
      </DialogHeader>
      <DialogFooter>
        <DialogClose intent="outline" isDisabled={remove.isPending}>
          Cancel
        </DialogClose>
        <Button
          intent="danger"
          isPending={remove.isPending}
          onPress={() =>
            remove.mutate(props.node.id, {
              onSuccess: props.onClose,
              onError: (error) => storageErrorToast(error, "It was not deleted"),
            })
          }
        >
          Delete forever
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Where a move may go. A member browses their workspace: in a company the top level lists My
 * files and Shared, so a move can cross between them. A link's Editor browses the shared folder
 * alone, from its top.
 */
export type MoveScope =
  | { kind: "member"; space: StorageSpace; path: { id: string; name: string }[] }
  | {
      kind: "link";
      shareId: string;
      top: { id: string; name: string };
      path: { id: string; name: string }[];
    };

type Browse = { space: StorageSpace | null; path: { id: string; name: string }[] } | null;

const SPACES = ["personal", "shared"] as const;

type Crumb = { id: string; name: string; go: () => void };

function useMoveBrowser(scope: MoveScope, moving: StorageNode[]) {
  const link = scope.kind === "link" ? scope : null;
  const hasShared = useHasSharedFiles();
  const [at, setAt] = useState<Browse>({
    space: scope.kind === "member" ? scope.space : null,
    path: scope.path,
  });
  const folder = at?.path.at(-1) ?? link?.top;
  const place = placeAt(at, folder);
  const member = useStorageList(place ?? { space: "personal" }, { enabled: !link && !!place });
  const shared = useStorageLink(...linkArgs(link, folder));
  const movingIds = new Set(moving.map((n) => n.id));
  const folders = (link ? shared.nodes : member.nodes).filter(
    (n) => n.kind === "folder" && !movingIds.has(n.id),
  );
  const here =
    !!at &&
    moving.every(
      (node) => (folder?.id ?? null) === node.parentId && (!!link || at.space === node.space),
    );
  const crumbs = crumbsFor({ link, at, setAt, hasShared });
  const { rows, enter } = rowsAt(at, folders, setAt);
  const listing = link ? shared : member;
  const loadMore = at && listing.hasNextPage ? () => void listing.fetchNextPage() : undefined;
  return {
    place,
    here,
    crumbs,
    rows,
    enter,
    loadMore,
    isLoadingMore: listing.isFetchingNextPage,
    shareId: link?.shareId,
  };
}

const crumbsFor: (props: {
  link: Extract<MoveScope, { kind: "link" }> | null;
  at: Browse;
  setAt: (at: Browse) => void;
  hasShared: boolean;
}) => Crumb[] = (props) => {
  const { link, at, setAt } = props;
  const trail = (path: { id: string; name: string }[], space: StorageSpace | null) =>
    path.map((entry, i) => ({ ...entry, go: () => setAt({ space, path: path.slice(0, i + 1) }) }));
  if (link) {
    return [
      { ...link.top, go: () => setAt({ space: null, path: [] }) },
      ...trail(at?.path ?? [], null),
    ];
  }
  const top = props.hasShared ? [{ id: "top", name: "Drive", go: () => setAt(null) }] : [];
  if (!at?.space) return top;
  const space = at.space;
  return [
    ...top,
    { id: space, name: SPACE_LABEL[space], go: () => setAt({ space, path: [] }) },
    ...trail(at.path, space),
  ];
};

const linkArgs: (
  link: Extract<MoveScope, { kind: "link" }> | null,
  folder: { id: string } | undefined,
) => [string, string | undefined, { enabled: boolean }] = (link, folder) => {
  if (!link) return ["", undefined, { enabled: false }];
  return [
    link.shareId,
    folder && folder.id !== link.top.id ? folder.id : undefined,
    { enabled: true },
  ];
};

function rowsAt(at: Browse, folders: StorageNode[], setAt: (at: Browse) => void) {
  if (!at) {
    return {
      rows: SPACES.map((space) => ({ id: space as string, name: SPACE_LABEL[space] })),
      enter: (key: string) => setAt({ space: key as StorageSpace, path: [] }),
    };
  }
  return {
    rows: folders.map(({ id, name }) => ({ id, name })),
    enter: (key: string) => {
      const next = folders.find((n) => n.id === key);
      if (next) setAt({ ...at, path: [...at.path, { id: next.id, name: next.name }] });
    },
  };
}

const placeAt: (at: Browse, folder: { id: string } | undefined) => StoragePlace | null = (
  at,
  folder,
) => {
  if (!at) return null;
  if (folder) return { parentId: folder.id };
  return { space: at.space ?? "personal" };
};

/** Picks the folder to move `nodes` into, one level at a time, then Move here. */
export function MoveDialog(props: { nodes: StorageNode[]; scope: MoveScope; onClose: () => void }) {
  const move = useMoveAll();
  const browse = useMoveBrowser(props.scope, props.nodes);
  const [only] = props.nodes;
  const { place, shareId } = browse;
  const crumbs = browse.crumbs;
  return (
    <Dialog size="sm" isOpen onOpenChange={(open) => !open && !move.isPending && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">
          {props.nodes.length === 1 && only
            ? `Move “${only.name}”`
            : `Move ${props.nodes.length} items`}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-2">
        <Breadcrumbs aria-label="Folder" className="min-h-5 flex-wrap gap-y-1 px-2">
          {crumbs.map((crumb) => (
            <BreadcrumbsItem key={crumb.id} onPress={crumb.go}>
              {crumb.name}
            </BreadcrumbsItem>
          ))}
        </Breadcrumbs>
        <GridList
          aria-label="Folders"
          className="h-45 overflow-y-auto"
          onAction={(key) => browse.enter(String(key))}
          renderEmptyState={() => null}
        >
          <Collection items={browse.rows}>
            {(item) => (
              <GridListItem
                id={item.id}
                textValue={item.name}
                className="h-9 shrink-0 cursor-pointer gap-2.5 rounded-lg px-2 hover:bg-accent"
              >
                <IconFolder className="size-icon shrink-0 text-muted-foreground" />
                <span className="truncate">{item.name}</span>
              </GridListItem>
            )}
          </Collection>
          <GridListLoadMoreItem onLoadMore={browse.loadMore} isLoading={browse.isLoadingMore} />
        </GridList>
      </DialogBody>
      <DialogFooter>
        <DialogClose intent="outline" isDisabled={move.isPending}>
          Cancel
        </DialogClose>
        <Button
          isDisabled={!place || browse.here}
          isPending={move.isPending}
          onPress={() => place && void move.run(props.nodes, place, shareId).then(props.onClose)}
        >
          Move here
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const BULK_AT_ONCE = 6;

function useMoveAll() {
  const change = useChangeNode();
  const [isPending, setPending] = useState(false);
  const run = async (nodes: StorageNode[], place: StoragePlace, shareId: string | undefined) => {
    setPending(true);
    const failed = await eachAtMost(nodes, BULK_AT_ONCE, (node) =>
      change.mutateAsync({ id: node.id, place, ...(shareId ? { shareId } : {}) }),
    );
    setPending(false);
    const [first] = failed;
    if (first) storageErrorToast(first.error, bulkFailure("moved", failed.length, nodes.length));
  };
  return { run, isPending };
}

/** "It was not moved", or "3 of 10 items were not moved". */
export function bulkFailure(verb: string, failed: number, of: number) {
  return of === 1 ? `It was not ${verb}` : `${failed} of ${of} items were not ${verb}`;
}

import { fileType } from "@omni/client";
import { useState } from "react";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { FileTile } from "@/components/storage/file-glyph";
import { SpaceIcon } from "@/components/storage/space-icons.tsx";
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
import { useTeamspaces } from "@/hooks/use-storage.ts";
import { useTeamFiles, type TeamFilesAt } from "@/hooks/use-team-files.ts";
import { IconCheck } from "@/components/icons/central";
import type { StorageNode } from "@/lib/storage.ts";

type Crumb = { id: string; name: string; teamspace?: true };

const atOf = (crumb: Crumb | undefined) =>
  (!crumb
    ? null
    : crumb.teamspace
      ? { teamspaceId: crumb.id }
      : { parentId: crumb.id }) satisfies TeamFilesAt;

/**
 * Picks one file the team already keeps in Drive as a contract's document or signed copy,
 * referenced where it lives (`docs/spec/contracts.md`, "In the CRM"): a search over Drive, or
 * browsing the member's spaces a folder at a time.
 */
export function ContractDriveDialog(props: {
  title: string;
  /** Only PDFs, as for a signed copy. */
  pdfOnly?: boolean;
  onPick: (node: StorageNode) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 200);
  const [path, setPath] = useState<Crumb[]>([]);
  const [picked, setPicked] = useState<StorageNode | null>(null);
  const files = useTeamFiles(q, atOf(path.at(-1)), !!props.pdfOnly);
  const { teamspaces } = useTeamspaces();
  const spaces = !q && path.length === 0 ? teamspaces.filter((t) => t.role !== null) : [];
  const enter = (node: StorageNode) => {
    setQuery("");
    setPath((now) => [...(q ? [] : now), { id: node.id, name: node.name }]);
  };
  const choose = () => {
    if (!picked) return;
    props.onPick(picked);
    props.onClose();
  };
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-2">
        <SearchField value={query} onChange={setQuery} aria-label="Search Drive" autoFocus>
          <SearchInput placeholder="Search Drive" />
        </SearchField>
        {!q && (
          <Breadcrumbs aria-label="Folder" className="min-h-5 flex-wrap gap-y-1 px-2">
            <BreadcrumbsItem onPress={() => setPath([])}>Spaces</BreadcrumbsItem>
            {path.map((crumb, i) => (
              <BreadcrumbsItem key={crumb.id} onPress={() => setPath(path.slice(0, i + 1))}>
                {crumb.name}
              </BreadcrumbsItem>
            ))}
          </Breadcrumbs>
        )}
        <GridList
          aria-label="Files"
          className="h-72 overflow-y-auto"
          selectionMode="single"
          selectionBehavior="toggle"
          disabledKeys={[
            ...spaces.map((t) => t.id),
            ...files.nodes.filter((n) => n.kind === "folder").map((n) => n.id),
          ]}
          disabledBehavior="selection"
          selectedKeys={picked ? [picked.id] : []}
          onAction={(key) => {
            const space = spaces.find((t) => t.id === key);
            const node = files.nodes.find((n) => n.id === key);
            if (space) setPath([{ id: space.id, name: space.name, teamspace: true }]);
            else if (node?.kind === "folder") enter(node);
            else if (node) setPicked(node);
          }}
          onSelectionChange={(keys) =>
            setPicked(files.nodes.find((n) => keys !== "all" && keys.has(n.id)) ?? null)
          }
          renderEmptyState={() => null}
        >
          <Collection items={spaces}>
            {(space) => (
              <GridListItem
                id={space.id}
                textValue={space.name}
                className="h-10 shrink-0 cursor-pointer gap-2.5 rounded-lg px-2 hover:bg-accent"
              >
                <SpaceIcon teamspace={space} className="size-icon" />
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
              </GridListItem>
            )}
          </Collection>
          <Collection items={files.nodes}>
            {(node) => (
              <GridListItem
                id={node.id}
                textValue={node.name}
                className="h-10 shrink-0 cursor-pointer gap-2.5 rounded-lg px-2 hover:bg-accent"
              >
                {({ isSelected }) => (
                  <>
                    <FileTile
                      kind={
                        node.kind === "folder" ? "folder" : fileType(node.name, node.mimeType).kind
                      }
                      size="xs"
                    />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {isSelected && <IconCheck aria-hidden className="size-icon" />}
                  </>
                )}
              </GridListItem>
            )}
          </Collection>
          <GridListLoadMoreItem onLoadMore={files.loadMore} isLoading={files.isLoadingMore} />
        </GridList>
      </DialogBody>
      <DialogFooter>
        <DialogClose intent="outline">Cancel</DialogClose>
        <Button isDisabled={!picked} onPress={choose}>
          Choose
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

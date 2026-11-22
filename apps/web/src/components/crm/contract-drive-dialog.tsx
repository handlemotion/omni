import { useState } from "react";
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
import { useTeamFiles } from "@/hooks/use-team-files.ts";
import { IconCheck } from "@/components/icons/central";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";

type Crumb = { id: string; name: string };

/**
 * Picks one file the team already keeps in Drive as a contract's document or signed copy,
 * referenced where it lives (`docs/spec/contracts.md`, "In the CRM"): a search over Drive, or
 * browsing the team's drive a folder at a time. Files in someone's My files are not offered.
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
  const files = useTeamFiles(q, path.at(-1)?.id ?? null, !!props.pdfOnly);
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
            <BreadcrumbsItem onPress={() => setPath([])}>{SPACE_LABEL.shared}</BreadcrumbsItem>
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
          disabledKeys={files.nodes.filter((n) => n.kind === "folder").map((n) => n.id)}
          disabledBehavior="selection"
          selectedKeys={picked ? [picked.id] : []}
          onAction={(key) => {
            const node = files.nodes.find((n) => n.id === key);
            if (node?.kind === "folder") enter(node);
            else if (node) setPicked(node);
          }}
          onSelectionChange={(keys) =>
            setPicked(files.nodes.find((n) => keys !== "all" && keys.has(n.id)) ?? null)
          }
          renderEmptyState={() => null}
        >
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

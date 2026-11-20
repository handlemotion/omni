import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { ListFailed } from "@/components/inbox/thread-list";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/ui/drop-zone";
import { FileTrigger } from "@/components/ui/file-trigger";
import type { InlineRename } from "@/hooks/use-inline-rename.ts";
import type { NodeSelection } from "@/hooks/use-node-selection.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { pickedFromInput, type Picked } from "@/lib/storage-upload-tree.ts";
import { FileSections, FileSectionsBones, type Drafts } from "./file-sections.tsx";
import type { FolderSource, OpenFile } from "./folder-view.tsx";
import { NodeMenu } from "./node-menu.tsx";
import { dropOperation, useDropInto, useRoomDrop, type NodeDrag } from "./node-drag.tsx";

interface Actions {
  onNewFolder: () => void;
  onFiles: (files: File[] | Picked) => void;
}

export function FolderBody(
  props: Actions & {
    source: FolderSource;
    menu: (node: StorageNode) => SettingsRowMenuItem[];
    open: OpenFile;
    drafts: Drafts;
    rename: InlineRename;
    selection: NodeSelection;
    onKeyDown: (event: KeyboardEvent) => void;
  },
) {
  const { source } = props;
  const drag = useFolderDrag(source);
  const into = useDropInto();
  const room = useRoomDrop("page", drag.here);
  return (
    <DropZone
      bare
      aria-label={`Upload to ${source.label}`}
      isDisabled={!source.canWrite}
      className="block min-h-0 min-w-0 flex-1 overflow-y-auto"
      getDropOperation={() => (drag.here ? dropOperation(drag.here) : "cancel")}
      onDrop={(event) => {
        if (drag.here) void into(drag.here, event.items);
      }}
    >
      <div ref={room} className="flex min-h-full flex-col" onKeyDownCapture={props.onKeyDown}>
        <Content {...props} drag={drag} />
      </div>
    </DropZone>
  );
}

const useFolderDrag: (source: FolderSource) => NodeDrag = (source) => {
  const { place, shareId, canWrite } = source;
  return useMemo(() => {
    const door = { shareId, canWrite };
    return { door, here: { ...door, place } };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId, canWrite, "parentId" in place ? place.parentId : place.space]);
};

function Content(props: Parameters<typeof FolderBody>[0] & { drag: NodeDrag }) {
  const { source, open } = props;
  const { list } = source;
  const { select } = open;
  const selected = useMemo(
    () => ({ id: open.id, onChange: (id: string | null) => select(id) }),
    [open.id, select],
  );
  if (list.isPending) {
    return (
      <Skeleton loading label="Loading files" skeleton={<FileSectionsBones />}>
        {null}
      </Skeleton>
    );
  }
  if (list.isError) {
    return (
      <Centered>
        <ListFailed retry={() => void list.refetch()} />
      </Centered>
    );
  }
  if (!list.nodes.length && !props.drafts.list.length) {
    return (
      <Centered>
        <EmptyState figure="drawer" {...source.empty}>
          {source.canWrite && <EmptyActions {...props} />}
        </EmptyState>
      </Centered>
    );
  }
  return (
    <NodeMenu nodes={list.nodes} menu={props.menu}>
      <FileSections
        label={source.label}
        nodes={list.nodes}
        href={source.folderHref}
        fileUrl={source.fileUrl}
        peek={!source.shareId}
        open={selected}
        menu={props.menu}
        drafts={props.drafts}
        rename={props.rename}
        selection={props.selection}
        drag={props.drag}
        loadMore={list.hasNextPage && !list.isFetchingNextPage ? fetchNext(list) : undefined}
      />
    </NodeMenu>
  );
}

const nextPage = new WeakMap<object, () => void>();
function fetchNext(list: FolderSource["list"]) {
  let next = nextPage.get(list.fetchNextPage);
  if (!next) {
    next = () => void list.fetchNextPage();
    nextPage.set(list.fetchNextPage, next);
  }
  return next;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}

function EmptyActions(props: Actions) {
  return (
    <>
      <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
        <Button size="sm">Upload</Button>
      </FileTrigger>
      <Button size="sm" intent="outline" onPress={props.onNewFolder}>
        New folder
      </Button>
    </>
  );
}

/** New folder and Upload, for whoever may write: labels alone, as the page's text actions. */
export function HeaderActions(props: Actions & { canWrite: boolean }) {
  if (!props.canWrite) return null;
  return (
    <>
      <Button intent="outline" size="sm" onPress={props.onNewFolder}>
        New folder
      </Button>
      <FileTrigger
        acceptDirectory
        onSelect={(files) => props.onFiles(pickedFromInput([...(files ?? [])]))}
      >
        <Button intent="outline" size="sm">
          Upload folder
        </Button>
      </FileTrigger>
      <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
        <Button size="sm">Upload</Button>
      </FileTrigger>
    </>
  );
}

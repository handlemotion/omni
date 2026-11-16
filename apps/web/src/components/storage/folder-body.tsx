// What a folder page shows under its header: its folders and files in their sections (or their
// skeleton, the failed load, the empty folder), all inside one drop target; and the header's
// actions.
import { useMemo, type ReactNode } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { ListFailed } from "@/components/inbox/thread-list";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/ui/drop-zone";
import { FileTrigger } from "@/components/ui/file-trigger";
import type { StorageNode } from "@/lib/storage.ts";
import { FileSections, FileSectionsBones } from "./file-sections.tsx";
import type { FolderSource, OpenFile } from "./folder-view.tsx";
import { NodeMenu } from "./node-menu.tsx";

interface Actions {
  onNewFolder: () => void;
  onFiles: (files: File[]) => void;
}

export function FolderBody(
  props: Actions & {
    source: FolderSource;
    menu: (node: StorageNode) => SettingsRowMenuItem[];
    open: OpenFile;
  },
) {
  const { source } = props;
  return (
    // The whole page under the header takes a drop, the empty folder included, and scrolls.
    <DropZone
      bare
      aria-label={`Upload to ${source.label}`}
      isDisabled={!source.canWrite}
      // A block that scrolls: content starts at the top, not centred by the drop zone's flex.
      className="block min-h-0 min-w-0 flex-1 overflow-y-auto"
      onDrop={(event) =>
        void Promise.all(
          event.items.flatMap((item) => (item.kind === "file" ? [item.getFile()] : [])),
        ).then(props.onFiles)
      }
    >
      <Content {...props} />
    </DropZone>
  );
}

function Content(props: Parameters<typeof FolderBody>[0]) {
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
  if (!list.nodes.length) {
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
        open={selected}
        menu={props.menu}
        loadMore={list.hasNextPage && !list.isFetchingNextPage ? fetchNext(list) : undefined}
      />
    </NodeMenu>
  );
}

const nextPage = new WeakMap<object, () => void>();
/** The list's next-page call, stable per query result so the sections stay memoized. */
function fetchNext(list: FolderSource["list"]) {
  let next = nextPage.get(list.fetchNextPage);
  if (!next) {
    next = () => void list.fetchNextPage();
    nextPage.set(list.fetchNextPage, next);
  }
  return next;
}

/** Fills the page under the header, so an empty state sits where the mail lists' do. */
function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col">{children}</div>;
}

/** An empty folder's way on, as the mail lists' empty states offer theirs: Upload first. */
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
      <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
        <Button size="sm">Upload</Button>
      </FileTrigger>
    </>
  );
}

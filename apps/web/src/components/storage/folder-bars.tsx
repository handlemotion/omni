import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FileTrigger } from "@/components/ui/file-trigger";
import type { NodeSelection } from "@/hooks/use-node-selection.ts";
import type { FolderSource } from "./folder-view.tsx";
import type { Picked } from "@/lib/storage-upload-tree.ts";
import { InPane } from "./in-pane.ts";
import { ViewToggle } from "./file-sections.tsx";
import { HeaderActions } from "./folder-body.tsx";
import { SelectionBar } from "./selection-bar.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";

/**
 * A folder's bar under its files, where a page has no header for it (a CRM record's Files tab):
 * the trail on the left; the page's actions and Upload on the right, or what a selection can do.
 */
export function FolderBottomBar(props: {
  trail: ReactNode;
  actions: ReactNode;
  selection: NodeSelection;
  source: FolderSource;
  onFiles: (files: File[]) => void;
  onMove: () => void;
}) {
  const { selection, source } = props;
  return (
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 bg-background px-5 pt-3 pb-4">
      <div className="flex min-w-0 flex-1 items-center">{props.trail}</div>
      {selection.active ? (
        <SelectionBar
          selection={selection}
          shareId={source.shareId}
          canMove={source.canWrite}
          canDownload={!!source.download}
          canTrash={source.canTrash}
          onMove={props.onMove}
        />
      ) : (
        <div className="flex gap-2">
          {props.actions}
          {source.canWrite && (
            <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
              <Button size="sm">Upload</Button>
            </FileTrigger>
          )}
        </div>
      )}
    </div>
  );
}

/** A folder in a pane with no header: its files, compact, then the bar under them. */
export function FolderPane(props: { bar: ReactNode; children: ReactNode }) {
  return (
    <InPane value={true}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {props.children}
        {props.bar}
        <UploadsPanel />
      </div>
    </InPane>
  );
}

/** A folder's header actions: the layout switch, the page's own, New and Upload, or what a selection can do. */
export function FolderActions(props: {
  extra: ReactNode;
  empty: boolean;
  selection: NodeSelection;
  source: FolderSource;
  onNewFolder: () => void;
  onNewDoc: (() => void) | undefined;
  newDocPending: boolean;
  onFiles: (files: File[] | Picked) => void;
  onMove: () => void;
}) {
  const { selection, source } = props;
  if (!selection.active) {
    if (props.empty) return null;
    return (
      <>
        <ViewToggle />
        {props.extra}
        <HeaderActions
          canWrite={source.canWrite}
          onNewFolder={props.onNewFolder}
          onNewDoc={props.onNewDoc}
          newDocPending={props.newDocPending}
          onFiles={props.onFiles}
        />
      </>
    );
  }
  return (
    <SelectionBar
      selection={selection}
      shareId={source.shareId}
      canMove={source.canWrite}
      canDownload={!!source.download}
      canTrash={source.canTrash}
      onMove={props.onMove}
    />
  );
}

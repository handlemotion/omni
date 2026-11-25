import type { ReactNode } from "react";
import {
  IconFolder,
  IconFolderPlus,
  IconNewDoc,
  IconPlus,
  IconTable,
  IconUpload,
} from "@/components/icons/central";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { FileTrigger } from "@/components/ui/file-trigger";
import type { NodeSelection } from "@/hooks/use-node-selection.ts";
import type { FolderSource } from "./folder-view.tsx";
import type { Picked } from "@/lib/storage-upload-tree.ts";
import { InPane } from "./in-pane.ts";
import { pickFiles } from "./folder-context.tsx";
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

/**
 * A folder's header actions: one bordered button that makes or uploads something here, then the
 * page's own (Share), or what a selection can do.
 */
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
    if (props.empty) return props.extra;
    return (
      <>
        {source.canWrite && (
          <AddMenu
            onNewFolder={props.onNewFolder}
            onNewDoc={props.onNewDoc}
            pending={props.newDocPending}
            onFiles={props.onFiles}
          />
        )}
        {props.extra}
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

function AddMenu(props: {
  onNewFolder: () => void;
  onNewDoc: (() => void) | undefined;
  pending: boolean;
  onFiles: (files: File[] | Picked) => void;
}) {
  return (
    <MenuTrigger>
      <Button intent="outline" size="sm" isPending={props.pending}>
        <IconPlus data-slot="icon" />
        New
      </Button>
      <Menu placement="bottom end" aria-label="New" popover={{ className: "min-w-56" }}>
        <MenuItem
          id="doc"
          textValue="New doc"
          isDisabled={!props.onNewDoc}
          onAction={props.onNewDoc}
        >
          <IconNewDoc data-slot="icon" />
          <MenuLabel>New doc</MenuLabel>
        </MenuItem>
        <MenuItem id="sheet" textValue="New sheet" isDisabled>
          <IconTable data-slot="icon" />
          <MenuLabel>New sheet</MenuLabel>
        </MenuItem>
        <MenuItem id="folder" textValue="New folder" onAction={props.onNewFolder}>
          <IconFolderPlus data-slot="icon" />
          <MenuLabel>New folder</MenuLabel>
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          id="upload-files"
          textValue="Upload files"
          onAction={() => pickFiles(props.onFiles)}
        >
          <IconUpload data-slot="icon" />
          <MenuLabel>Upload files</MenuLabel>
        </MenuItem>
        <MenuItem
          id="upload-folder"
          textValue="Upload folder"
          onAction={() => pickFiles(props.onFiles, true)}
        >
          <IconFolder data-slot="icon" />
          <MenuLabel>Upload folder</MenuLabel>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

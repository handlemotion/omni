import { useState } from "react";
import { IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { canConvertToDoc, useConvertToDoc } from "@/hooks/use-convert-doc.ts";
import { useTrashNode } from "@/hooks/use-storage.ts";
import type { NodeSelection } from "@/hooks/use-node-selection.ts";
import { downloadZip } from "@/lib/download.ts";
import { eachAtMost } from "@/lib/each-at-most.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { bulkFailure } from "./file-dialogs.tsx";
import { storageErrorToast } from "./storage-errors.ts";

const TRASH_AT_ONCE = 6;

/**
 * The header while items are selected, in place of New folder and Upload: how many, and what can
 * be done to all of them at once. Download is one zip (W2's `/zip`), so it works on folders too.
 */
export function SelectionBar(props: {
  selection: NodeSelection;
  shareId: string | undefined;
  canMove: boolean;
  canDownload: boolean;
  canTrash: (node: StorageNode) => boolean;
  onMove: () => void;
}) {
  const { selection } = props;
  const trash = useBulkTrash(props.shareId);
  const trashable = selection.nodes.every(props.canTrash);
  const convert = useConvertToDoc();
  const convertible = props.canMove && !props.shareId && selection.nodes.some(canConvertToDoc);
  return (
    <>
      <CheckboxField
        aria-label="Select all"
        isSelected={selection.all}
        isIndeterminate={!selection.all}
        onChange={(all) => (all ? selection.selectAll() : selection.clear())}
      >
        <Checkbox />
      </CheckboxField>
      <span className="px-1 text-sm text-muted-foreground tabular-nums">
        {selection.nodes.length} selected
      </span>
      {props.canDownload && (
        <Button
          intent="outline"
          size="sm"
          onPress={() =>
            downloadZip(
              selection.nodes.map((n) => n.id),
              props.shareId,
            )
          }
        >
          Download
        </Button>
      )}
      {props.canMove && (
        <Button intent="outline" size="sm" onPress={props.onMove}>
          Move
        </Button>
      )}
      {convertible && (
        <Button
          intent="outline"
          size="sm"
          isPending={convert.isPending}
          onPress={() => void convert.run(selection.nodes).then(selection.clear)}
        >
          Convert to Omni doc
        </Button>
      )}
      {trashable && (
        <Button
          intent="outline"
          size="sm"
          isPending={trash.isPending}
          onPress={() => void trash.run(selection.nodes).then(selection.clear)}
        >
          Move to trash
        </Button>
      )}
      <Button intent="plain" size="sq-sm" aria-label="Clear selection" onPress={selection.clear}>
        <IconX />
      </Button>
    </>
  );
}

/** Trashes each node, a few at a time; one toast says how many failed. */
export function useBulkTrash(shareId: string | undefined) {
  const trash = useTrashNode();
  const [isPending, setPending] = useState(false);
  const run = async (nodes: StorageNode[]) => {
    setPending(true);
    const failed = await eachAtMost(nodes, TRASH_AT_ONCE, (node) =>
      trash.mutateAsync({ id: node.id, ...(shareId ? { shareId } : {}) }),
    );
    setPending(false);
    const [first] = failed;
    if (first) {
      storageErrorToast(first.error, bulkFailure("moved to Trash", failed.length, nodes.length));
    }
  };
  return { run, isPending };
}

import { memo, useState } from "react";
import { IconArrowRotateClockwise, IconUserAdd, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { useUploadItems, useUploads } from "@/hooks/use-storage.ts";
import type { UploadItem } from "@/lib/storage-uploads.ts";
import { ShareUploadDialog } from "./share-dialog.tsx";
import { canRetryUpload, storageErrorText } from "./storage-errors.ts";

const ROW_PX = 48;
const PANEL_PX = 288;
const OVERSCAN = 4;

export function UploadsPanel() {
  const uploads = useUploadItems();
  const { retry, remove } = useUploads();
  const [top, setTop] = useState(0);
  const [sharing, setSharing] = useState<{ uploadId: string; name: string } | null>(null);
  if (!uploads.length && !sharing) return null;
  const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN);
  const last = Math.min(uploads.length, Math.ceil((top + PANEL_PX) / ROW_PX) + OVERSCAN);
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-end">
      {sharing && <ShareUploadDialog {...sharing} onClose={() => setSharing(null)} />}
      {uploads.length > 0 && (
        <div
          className="pointer-events-auto w-80 max-w-full overflow-y-auto rounded-lg border bg-background px-3 py-1.5 shadow-(--shadow-overlay)"
          style={{ maxHeight: PANEL_PX }}
          onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        >
          <ul className="relative" style={{ height: uploads.length * ROW_PX }}>
            {uploads.slice(first, last).map((item, i) => (
              <Row
                key={item.id}
                item={item}
                at={(first + i) * ROW_PX}
                retry={retry}
                remove={remove}
                share={setSharing}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const Row = memo(function Row(props: {
  item: UploadItem;
  at: number;
  retry: (id: number) => void;
  remove: (id: number) => void;
  share: (upload: { uploadId: string; name: string }) => void;
}) {
  const { item } = props;
  const failed = item.status === "failed";
  const percent = item.size ? Math.floor((item.sent / item.size) * 100) : 0;
  return (
    <li
      className="absolute inset-x-0 flex flex-col justify-center gap-1.5"
      style={{ top: props.at, height: ROW_PX }}
    >
      <div className="flex h-6 items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        {!failed && <span className="shrink-0 text-muted-foreground tabular-nums">{percent}%</span>}
        {item.shareable && (
          <Button
            intent="plain"
            size="sq-2xs"
            aria-label={`Share ${item.name}`}
            onPress={() => props.share({ uploadId: item.shareable!, name: item.name })}
          >
            <IconUserAdd />
          </Button>
        )}
        {failed && canRetryUpload(item.error) && (
          <Button
            intent="plain"
            size="sq-2xs"
            aria-label={`Retry ${item.name}`}
            onPress={() => props.retry(item.id)}
          >
            <IconArrowRotateClockwise />
          </Button>
        )}
        <Button
          intent="plain"
          size="sq-2xs"
          aria-label={failed ? `Remove ${item.name}` : `Cancel ${item.name}`}
          onPress={() => props.remove(item.id)}
        >
          <IconX />
        </Button>
      </div>
      {failed ? (
        <span className="truncate text-xs text-muted-foreground">
          {storageErrorText(item.error, "Not uploaded")}
        </span>
      ) : (
        <ProgressBar aria-label={`Uploading ${item.name}`} value={percent}>
          <ProgressBarTrack />
        </ProgressBar>
      )}
    </li>
  );
});

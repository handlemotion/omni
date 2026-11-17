import { Skeleton } from "skullet/react";
import { IconDownload, IconRestore } from "@/components/icons/central";
import { SettingsRowMenu } from "@/components/settings/kit/settings-row-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileTrigger } from "@/components/ui/file-trigger";
import { useRestoreVersion, useStorageVersions, useUploads } from "@/hooks/use-storage.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { storageVersionUrl, type StorageVersions } from "@/lib/storage-versions.ts";
import { storageErrorToast } from "./storage-errors.ts";

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const SAMPLE: StorageVersions = {
  current: {
    size: 0,
    mimeType: null,
    writtenAt: new Date(0).toISOString(),
    writtenByName: "Someone",
  },
  versions: [],
  keepDays: 30,
};

export function VersionsDialog(props: {
  node: StorageNode;
  shareId?: string | undefined;
  onClose: () => void;
}) {
  const { node, shareId } = props;
  const versions = useStorageVersions(node.id, shareId);
  const restore = useRestoreVersion();
  const { upload } = useUploads();
  const send = (file: File | undefined) =>
    file &&
    upload(
      [file],
      {
        place: node.parentId ? { parentId: node.parentId } : { space: node.space },
        shareId,
        replaces: node.id,
      },
      (_name, error) => storageErrorToast(error, `“${node.name}” was not updated`),
    );
  return (
    <Dialog size="sm" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Versions of “{node.name}”</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Skeleton
          id="storage-versions"
          data={versions.data}
          sample={SAMPLE}
          label="Loading versions"
        >
          {(state) => (
            <ul className="flex flex-col gap-2">
              <Row content={state.current} end={<Badge intent="secondary">Current</Badge>} />
              {state.versions.map((version) => (
                <Row
                  key={version.id}
                  content={version}
                  end={
                    <SettingsRowMenu
                      label={`Actions for the version of ${WHEN.format(new Date(version.writtenAt))}`}
                      disabled={restore.isPending}
                      items={[
                        {
                          icon: IconDownload,
                          label: "Download",
                          onAction: () =>
                            window.location.assign(storageVersionUrl(node.id, version.id, shareId)),
                        },
                        {
                          icon: IconRestore,
                          label: "Restore",
                          onAction: () =>
                            restore.mutate(
                              {
                                id: node.id,
                                versionId: version.id,
                                ...(shareId ? { shareId } : {}),
                              },
                              {
                                onError: (error) => storageErrorToast(error, "It was not restored"),
                              },
                            ),
                        },
                      ]}
                    />
                  }
                />
              ))}
            </ul>
          )}
        </Skeleton>
      </DialogBody>
      <DialogFooter>
        <FileTrigger onSelect={(files) => send(files?.[0])}>
          <Button intent="outline">Upload new version</Button>
        </FileTrigger>
      </DialogFooter>
    </Dialog>
  );
}

function Row(props: { content: StorageVersions["current"]; end: React.ReactNode }) {
  const { content } = props;
  return (
    <li className="flex min-h-10 items-center gap-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm tabular-nums">
          {WHEN.format(new Date(content.writtenAt))}
        </span>
        {content.writtenByName && (
          <span className="truncate text-xs text-muted-foreground">{content.writtenByName}</span>
        )}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {formatBytes(content.size)}
      </span>
      <span className="flex min-w-16 shrink-0 justify-end">{props.end}</span>
    </li>
  );
}

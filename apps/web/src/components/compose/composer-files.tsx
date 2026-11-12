import { FileTrigger } from "react-aria-components/FileTrigger";
import { IconCircleX, IconPaperclip } from "@/components/icons/central";
import { Button, buttonStyles } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { ComposerFile } from "@/hooks/use-compose.ts";

const SIZE = new Intl.NumberFormat(undefined, {
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
});
const PERCENT = new Intl.NumberFormat(undefined, { style: "percent" });

/** The paperclip in the composer's toolbar. */
export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  return (
    <FileTrigger allowsMultiple onSelect={(list) => list && onFiles([...list])}>
      <TooltipTrigger delay={400}>
        <Button intent="ghost" size="sq-sm" aria-label="Attach files">
          <IconPaperclip />
        </Button>
        <Tooltip>Attach files</Tooltip>
      </TooltipTrigger>
    </FileTrigger>
  );
}

/**
 * The composer's files as chips, like the message's own (`AttachmentChips`): the size once
 * staged, the percentage while uploading, "Failed" when it could not be stored. Each removes.
 */
export function ComposerFiles(props: { files: ComposerFile[]; onRemove: (id: string) => void }) {
  if (!props.files.length) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
      {props.files.map((file) => (
        <li
          key={file.id}
          className={buttonStyles({
            intent: "outline",
            size: "sm",
            className: "max-w-64 pe-1 hover:bg-transparent active:scale-100",
          })}
        >
          <IconPaperclip />
          <span className="truncate">{file.filename || "Attachment"}</span>
          <span
            className={
              file.status === "failed"
                ? "shrink-0 text-danger-subtle-foreground"
                : "shrink-0 text-subtle-foreground tabular-nums"
            }
            title={file.error}
          >
            {file.status === "uploading"
              ? PERCENT.format(file.progress)
              : file.status === "failed"
                ? "Failed"
                : SIZE.format(file.size)}
          </span>
          <Button
            intent="ghost"
            size="sq-xs"
            aria-label={`Remove ${file.filename}`}
            onPress={() => props.onRemove(file.id)}
          >
            <IconCircleX />
          </Button>
        </li>
      ))}
    </ul>
  );
}

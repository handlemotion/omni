import { IconArrowUpRight, IconDownload } from "@/components/icons/central";
import { AttachmentGlyph } from "@/components/storage/file-glyph.tsx";
import { buttonStyles } from "@/components/ui/button";
import { contextMenuProps } from "@/components/ui/context-menu";
import { Link } from "@/components/ui/link";
import { downloadFile } from "@/lib/download.ts";
import type { Message } from "@/lib/types.ts";
import { attachmentUrl } from "@/lib/urls.ts";

type Attachment = Message["attachments"][number];

const SIZE = new Intl.NumberFormat(undefined, {
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
});

/**
 * A message's files as chips under it (spec "Rendering rules"). Each opens or downloads, from a
 * press or its context menu.
 */
export function AttachmentChips({
  threadId,
  attachments,
  align = "start",
}: {
  threadId: string;
  attachments: Attachment[];
  align?: "start" | "end";
}) {
  if (!attachments.length) return null;
  return (
    <ul
      aria-label="Attachments"
      className={`flex flex-wrap gap-2 ${align === "end" ? "justify-end" : ""}`}
    >
      {attachments.map((file) => (
        <li
          key={file.id}
          className="min-w-0"
          {...contextMenuProps(() => {
            const url = attachmentUrl(threadId, file.id);
            return [
              {
                icon: IconArrowUpRight,
                label: "Open",
                onAction: () => window.open(url, "_blank", "noopener,noreferrer"),
              },
              { icon: IconDownload, label: "Download", onAction: () => downloadFile(url) },
            ];
          }, file.filename || "Attachment")}
        >
          <Link
            href={attachmentUrl(threadId, file.id)}
            target="_blank"
            rel="noreferrer"
            className={buttonStyles({ intent: "outline", size: "sm", className: "max-w-64" })}
          >
            <AttachmentGlyph name={file.filename} mimeType={file.mimeType} />
            <span className="truncate">{file.filename || "Attachment"}</span>
            <span className="shrink-0 text-subtle-foreground tabular-nums">
              {SIZE.format(file.size)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

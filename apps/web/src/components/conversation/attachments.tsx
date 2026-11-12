import { IconPaperclip } from "@/components/icons/central";
import { buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import type { Message } from "@/lib/types.ts";
import { attachmentUrl } from "@/lib/urls.ts";

type Attachment = Message["attachments"][number];

const SIZE = new Intl.NumberFormat(undefined, {
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
});

/** A message's files as chips under it (spec "Rendering rules"). Each opens or downloads. */
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
        <li key={file.id} className="min-w-0">
          <Link
            href={attachmentUrl(threadId, file.id)}
            target="_blank"
            rel="noreferrer"
            className={buttonStyles({ intent: "outline", size: "sm", className: "max-w-64" })}
          >
            <IconPaperclip />
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

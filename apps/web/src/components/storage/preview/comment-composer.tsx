// The comment bar the preview's island shows: the app's chat box alone (`ChatBox`, as the
// comments sidebar writes in), floating over the island. A comment on the whole file, or, once a
// box is drawn with the area tool, on that part of the page; the box itself shows which. Esc
// closes it. Reading threads is the comments sidebar's job.
import { useEffect, useRef, useState } from "react";
import { ChatBox } from "@/components/chat/chat-box";
import { useAddComment } from "@/hooks/use-storage.ts";
import type { PdfBox } from "./pdf-marks.tsx";

export function CommentComposer(props: {
  fileId: string;
  shareId?: string | undefined;
  /** A box drawn on a PDF page; the whole file when null. */
  draft: PdfBox | null;
  /** The file's content the box was drawn on; the API's 409 if it was replaced since. */
  contentVersion?: number | undefined;
  onClose: () => void;
  onSent: () => void;
}) {
  // A failure shows the app's own toast.
  const add = useAddComment();
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = props;

  // Opened to write: straight to the text, and again for each new box.
  useEffect(() => field.current?.focus(), [draft]);

  const send = () => {
    const body = text.trim();
    if (!body || add.isPending) return;
    add.mutate(
      {
        id: props.fileId,
        ...(props.shareId ? { shareId: props.shareId } : {}),
        body: {
          body,
          ...(draft ? { anchor: { kind: "pdf" as const, ...draft } } : {}),
          ...(draft && props.contentVersion !== undefined
            ? { contentVersion: props.contentVersion }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setText("");
          props.onSent();
        },
      },
    );
  };

  return (
    <ChatBox
      textareaRef={field}
      value={text}
      onChange={setText}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
      label="Comment"
      placeholder="Add a comment…"
      sendLabel="Send"
      canSend={!!text.trim() && !add.isPending}
      onSend={send}
    />
  );
}

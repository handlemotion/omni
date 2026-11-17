import { useEffect, useRef, useState } from "react";
import { ChatBox } from "@/components/chat/chat-box";
import { useAddComment } from "@/hooks/use-storage.ts";
import type { StorageCommentAnchor } from "@/lib/storage-comments.ts";

export function CommentComposer(props: {
  fileId: string;
  shareId?: string | undefined;
  /** Where the comment points: a box drawn on the file; the whole file when null. */
  anchor: StorageCommentAnchor | null;
  /** The file's content the box was drawn on; the API's 409 if it was replaced since. */
  contentVersion?: number | undefined;
  onClose: () => void;
  onSent: () => void;
}) {
  const add = useAddComment();
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const { anchor } = props;

  const where = anchor ? JSON.stringify(anchor) : "file";
  useEffect(() => field.current?.focus(), [where]);

  const send = () => {
    const body = text.trim();
    if (!body || add.isPending) return;
    add.mutate(
      {
        id: props.fileId,
        ...(props.shareId ? { shareId: props.shareId } : {}),
        body: {
          body,
          ...(anchor ? { anchor } : {}),
          ...(anchor && props.contentVersion !== undefined
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

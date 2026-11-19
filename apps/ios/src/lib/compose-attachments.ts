import { toApiError, type Message } from "@omni/client";
import { File, UploadType } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { ApiError, api, call } from "./api.ts";
import type { SendAttachment } from "./compose.ts";
import { storageHeaders } from "./drive.ts";
import { pickDocuments, pickMedia } from "./drive-uploads.ts";
import type { PickedFile } from "./drive-upload.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

/** One file on a message being written: uploading, ready to send, or failed. */
export interface ComposeAttachment {
  key: string;
  file: PickedFile;
  /** The mailbox it was uploaded for: an upload goes out only from its own mailbox. */
  mailboxId: string;
  state: "uploading" | "ready" | "failed";
  uploadId?: string;
  /** An original's attachment a forward carries over, sent by id instead of uploaded. */
  attachmentId?: string;
}

let next = 0;

async function upload(file: PickedFile, mailboxId: string) {
  const url = api.uploads.$url({ query: { mailboxId, filename: file.name } }).toString();
  const headers = {
    ...(await storageHeaders(currentWorkspaceId())),
    "content-type": file.mimeType ?? "application/octet-stream",
  };
  const result = await new File(file.uri).upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(result.body);
  } catch {
    body = null;
  }
  if (result.status >= 200 && result.status < 300) return (body as { id: string }).id;
  const { message, ...info } = toApiError(body, `upload ${result.status}`);
  throw new ApiError(result.status, message, info);
}

/** The original's files a forward starts with, as the web's `originalFiles`: inline images stay out. */
export function originalAttachments(message: Message | undefined, mailboxId: string) {
  return (message?.attachments ?? [])
    .filter((a) => !a.inline)
    .map(
      (a) =>
        ({
          key: `a${++next}`,
          file: { uri: "", name: a.filename, size: a.size, mimeType: a.mimeType },
          mailboxId,
          state: "ready",
          attachmentId: a.id,
        }) satisfies ComposeAttachment,
    );
}

/**
 * The files on a message being written, uploaded for `mailboxId` as they are picked (the web's
 * upload-then-send). Changing the mailbox uploads them again for the new one. `attachments` is
 * what Send carries; `pending` holds Send while any file is uploading or failed, until it
 * finishes or is taken off, so a message never goes out without a file it shows. `initial` seeds
 * it (a forward's originals).
 */
export function useComposeAttachments(mailboxId: string, initial: ComposeAttachment[] = []) {
  const [list, setList] = useState<ComposeAttachment[]>(initial);
  const current = useRef(list);
  current.current = list;
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const settle = useCallback((key: string, mailbox: string, change: Partial<ComposeAttachment>) => {
    if (!alive.current) return;
    setList((now) =>
      now.map((a) => (a.key === key && a.mailboxId === mailbox ? { ...a, ...change } : a)),
    );
  }, []);
  const start = useCallback(
    (key: string, file: PickedFile, mailbox: string) => {
      upload(file, mailbox).then(
        (uploadId) => settle(key, mailbox, { state: "ready", uploadId }),
        (error: unknown) => {
          settle(key, mailbox, { state: "failed" });
          Alert.alert("Not attached", error instanceof Error ? error.message : undefined);
        },
      );
    },
    [settle],
  );
  const add = async (pick: () => Promise<PickedFile[]>) => {
    const files = await pick().catch(() => [] as PickedFile[]);
    const fresh = files.map((file) => ({
      key: `a${++next}`,
      file,
      mailboxId,
      state: "uploading" as const,
    }));
    setList((now) => [...now, ...fresh]);
    for (const one of fresh) start(one.key, one.file, mailboxId);
  };
  useEffect(() => {
    const stale = current.current.filter((a) => a.mailboxId !== mailboxId && !a.attachmentId);
    if (!stale.length) return;
    setList((now) =>
      now.map((a) =>
        a.mailboxId === mailboxId || a.attachmentId
          ? a
          : { key: a.key, file: a.file, mailboxId, state: "uploading" },
      ),
    );
    for (const one of stale) start(one.key, one.file, mailboxId);
  }, [mailboxId, start]);
  const remove = (key: string) => {
    const gone = list.find((a) => a.key === key);
    setList((now) => now.filter((a) => a.key !== key));
    if (gone?.uploadId) {
      void call(api.uploads[":id"].$delete({ param: { id: gone.uploadId } })).catch(() => {});
    }
  };
  const attachments: SendAttachment[] = list.flatMap((a) => {
    const one: SendAttachment | undefined = a.attachmentId
      ? { kind: "attachment", attachmentId: a.attachmentId }
      : a.state === "ready" && a.uploadId
        ? { kind: "upload", uploadId: a.uploadId }
        : undefined;
    return one ? [one] : [];
  });
  return {
    list,
    attachments,
    pending: list.some((a) => a.state !== "ready"),
    attachFiles: () => void add(pickDocuments),
    attachMedia: () => void add(pickMedia),
    remove,
  };
}

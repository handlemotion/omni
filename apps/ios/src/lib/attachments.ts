import { WORKSPACE_HEADER } from "@omni/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { api, auth, call } from "./api.ts";
import { config } from "./config.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

export interface AttachmentRef {
  threadId: string;
  attachmentId: string;
  filename: string;
}

const fileName = (name: string) => name.replace(/[/\\:]/g, "_").trim() || "Attachment";

async function downloadAgainEveryTime({ threadId, attachmentId, filename }: AttachmentRef) {
  const folder = new Directory(Paths.cache, "attachments", attachmentId);
  folder.create({ idempotent: true, intermediates: true });
  const file = new File(folder, fileName(filename));
  const headers: Record<string, string> = {};
  const cookie = await auth.getCookie();
  if (cookie) headers.cookie = cookie;
  const workspace = currentWorkspaceId();
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  const url = `${config.apiUrl}/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`;
  await File.downloadFileAsync(url, file, { headers, idempotent: true });
  return { file, folder };
}

/** An attachment as a file on this phone: its `uri`, and the folder a web view may read. */
export const useAttachmentFile = (ref: AttachmentRef) =>
  useQuery({
    queryKey: keys.attachmentFile(ref.attachmentId),
    queryFn: async () => {
      const { file, folder } = await downloadAgainEveryTime(ref);
      return { uri: file.uri, folderUri: folder.uri };
    },
    gcTime: 0,
    staleTime: Infinity,
  });

/** Opens the share sheet on the downloaded file: Save to Files, or open it in another app. */
export async function shareAttachment(uri: string, mimeType: string | undefined, name: string) {
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: name });
}

/** Copies an attachment into the person's My files (`POST /api/mail/attachments/:id/save-to-drive`). */
export function useSaveToDrive() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) =>
      call(api.mail.attachments[":id"]["save-to-drive"].$post({ param: { id: attachmentId } })),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.drive("personal") }),
  });
}

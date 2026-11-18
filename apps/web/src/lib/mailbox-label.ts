import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

const refreshInboxes = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.mail() }),
    client.invalidateQueries({ queryKey: keys.workspaces() }),
  ]);

/** `mutate({ mailboxId, label })`: names one of your personal inboxes; null clears it. */
export const labelMailboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (vars: { mailboxId: string; label: string | null }) =>
      call(
        api.mailboxes[":id"].label.$put({
          param: { id: vars.mailboxId },
          json: { label: vars.label },
        }),
      ),
    onSettled: () => refreshInboxes(client),
  });

/** `mutate({ mailboxId, senderName })`: the From name of one of your personal inboxes. */
export const senderNameMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (vars: { mailboxId: string; senderName: string | null }) =>
      call(
        api.mailboxes[":id"]["sender-name"].$put({
          param: { id: vars.mailboxId },
          json: { senderName: vars.senderName },
        }),
      ),
    onSettled: () => refreshInboxes(client),
  });

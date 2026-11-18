import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

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
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.mail() }),
        client.invalidateQueries({ queryKey: keys.workspaces() }),
      ]),
  });

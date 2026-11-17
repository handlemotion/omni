import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/**
 * Every mailbox of the active workspace for its owners and admins: shared ones with their head
 * count, personal ones with their owner, each with its sync health. Never their mail. 403 for
 * anyone else, so only managers' screens ask.
 */
export { workspaceInboxesQuery as workspaceMailboxesQuery } from "./workspace-admin.ts";

export const mailboxMembersQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.mailboxMembers(mailboxId),
    queryFn: ({ signal }) =>
      call(
        api.workspace["shared-inboxes"][":id"].people.$get(
          { param: { id: mailboxId } },
          { init: { signal } },
        ),
      ).then(({ people }) => ({ members: people })),
  });

export interface MailboxMemberChange {
  mailboxId: string;
  memberId: string;
}

const settle = (client: QueryClient, mailboxId: string) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.mailboxMembers(mailboxId) }),
    client.invalidateQueries({ queryKey: keys.workspaceMembers() }),
    client.invalidateQueries({ queryKey: keys.mail() }),
  ]);

/** Idempotent on the server (a PUT), so a retry is safe without a key. */
export const addMailboxMemberMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ mailboxId, memberId }: MailboxMemberChange) =>
      call(
        api.workspace["shared-inboxes"][":id"].people[":memberId"].$put({
          param: { id: mailboxId, memberId },
        }),
      ),
    onSettled: (_data, _error, { mailboxId }) => settle(client, mailboxId),
  });

export const removeMailboxMemberMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ mailboxId, memberId }: MailboxMemberChange) =>
      call(
        api.workspace["shared-inboxes"][":id"].people[":memberId"].$delete({
          param: { id: mailboxId, memberId },
        }),
      ),
    onSettled: (_data, _error, { mailboxId }) => settle(client, mailboxId),
  });

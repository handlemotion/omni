// Who can see a shared mailbox (ADR 0008): its Better Auth team, managed through the Worker so
// the team and the access grants change together. Owners and admins add and remove; anyone on
// the mailbox can list. Pick people to add from `membersQuery` (the organization's members).
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export const mailboxMembersQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.mailboxMembers(mailboxId),
    queryFn: ({ signal }) =>
      call(api.mailboxes[":id"].members.$get({ param: { id: mailboxId } }, { init: { signal } })),
  });

export interface MailboxMemberChange {
  mailboxId: string;
  memberId: string;
}

/**
 * Access decides which mailboxes and threads someone sees, and the actor may have changed their
 * own. Refetch the list, the mailboxes and everything mail-related on screen.
 */
const settle = (client: QueryClient, mailboxId: string) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.mailboxMembers(mailboxId) }),
    client.invalidateQueries({ queryKey: keys.mail() }),
  ]);

/** Idempotent on the server (a PUT), so a retry is safe without a key. */
export const addMailboxMemberMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ mailboxId, memberId }: MailboxMemberChange) =>
      call(api.mailboxes[":id"].members[":memberId"].$put({ param: { id: mailboxId, memberId } })),
    onSettled: (_data, _error, { mailboxId }) => settle(client, mailboxId),
  });

export const removeMailboxMemberMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ mailboxId, memberId }: MailboxMemberChange) =>
      call(
        api.mailboxes[":id"].members[":memberId"].$delete({ param: { id: mailboxId, memberId } }),
      ),
    onSettled: (_data, _error, { mailboxId }) => settle(client, mailboxId),
  });

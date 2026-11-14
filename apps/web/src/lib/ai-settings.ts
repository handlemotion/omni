// The workspace's AI settings (ADR 0033), for owners and admins: what each member handles, which
// triage reads to assign a shared inbox's conversations, and what each shared inbox's tags are for.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export const aiSettingsQuery = () =>
  queryOptions({
    queryKey: keys.aiSettings(),
    queryFn: ({ signal }) => call(api.workspace.ai.$get(undefined, { init: { signal } })),
  });

export type AiSettings = Awaited<
  ReturnType<NonNullable<ReturnType<typeof aiSettingsQuery>["queryFn"]>>
>;

/** A blank role clears it. */
export const setRoleMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ memberId, description }: { memberId: string; description: string }) =>
      call(
        api.workspace.ai.members[":memberId"].role.$put({
          param: { memberId },
          json: { description },
        }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: keys.aiSettings() }),
  });

/**
 * A blank description clears it. Written through the inbox's own tag route, which checks the
 * member is on the inbox; the inbox's tag list picks the change up too.
 */
export const setTagDescriptionMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      mailboxId,
      tagId,
      description,
    }: {
      mailboxId: string;
      tagId: string;
      description: string;
    }) =>
      call(
        api.mailboxes[":id"].tags[":tagId"].$patch({
          param: { id: mailboxId, tagId },
          json: { description },
        }),
      ),
    onSettled: (_data, _error, { mailboxId }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.aiSettings() }),
        client.invalidateQueries({ queryKey: keys.tags(mailboxId) }),
      ]),
  });

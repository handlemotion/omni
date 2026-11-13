// Join requests (ADR 0024): a sign-in with a company's address reaches only that company, so
// someone who is not its member asks to join, and its owners and admins accept or decline.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/** `{ company: { id, name }, requested }` for a scoped sign-in with no member there. */
export const joinQuery = () =>
  queryOptions({
    queryKey: keys.join(),
    queryFn: ({ signal }) => call(api.join.$get(undefined, { init: { signal } })),
  });

export const askToJoinMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: () => call(api.join.$post()),
    onSuccess: (status) => client.setQueryData(keys.join(), status),
  });

/** The requests waiting in the active workspace (owners and admins). */
export const joinRequestsQuery = (enabled = true) =>
  queryOptions({
    queryKey: keys.joinRequests(),
    queryFn: ({ signal }) => call(api.join.requests.$get(undefined, { init: { signal } })),
    enabled,
  });

/** `mutate({ id, answer })`: accept adds them as a member; decline drops the request. */
export const answerJoinRequestMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, answer }: { id: string; answer: "accept" | "decline" }) =>
      call(
        answer === "accept"
          ? api.join.requests[":id"].accept.$post({ param: { id } })
          : api.join.requests[":id"].decline.$post({ param: { id } }),
      ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.joinRequests() }),
        client.invalidateQueries({ queryKey: keys.members() }),
      ]),
  });

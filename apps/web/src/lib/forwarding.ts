// CRM forwarding address (ADR 0032): each personal mailbox you own, in any workspace, can send
// copies of its mail to a CRM's forwarding address (Attio, HubSpot, ...).
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { ForwardScope } from "./types.ts";

export const forwardingQuery = () =>
  queryOptions({
    queryKey: keys.forwarding(),
    queryFn: ({ signal }) => call(api.forwarding.$get(undefined, { init: { signal } })),
  });

const settle = (client: QueryClient) => client.invalidateQueries({ queryKey: keys.forwarding() });

export const setForwardingMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (vars: { mailboxId: string; address: string; scope: ForwardScope }) =>
      call(
        api.mailboxes[":id"].forwarding.$put({
          param: { id: vars.mailboxId },
          json: { address: vars.address, scope: vars.scope },
        }),
      ),
    onSettled: () => settle(client),
  });

export const clearForwardingMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (mailboxId: string) =>
      call(api.mailboxes[":id"].forwarding.$delete({ param: { id: mailboxId } })),
    onSettled: () => settle(client),
  });

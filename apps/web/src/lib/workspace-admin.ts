import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { MailServer } from "./onboarding.ts";

/** Every member with the inboxes each can open. 403 for a plain member, so only managers ask. */
export const workspaceMembersQuery = () =>
  queryOptions({
    queryKey: keys.workspaceMembers(),
    queryFn: ({ signal }) => call(api.workspace.members.$get(undefined, { init: { signal } })),
  });

/** Every mailbox of the workspace; `orphaned` marks one whose owner left. */
export const workspaceInboxesQuery = () =>
  queryOptions({
    queryKey: keys.workspaceMailboxes(),
    queryFn: ({ signal }) => call(api.workspace.inboxes.$get(undefined, { init: { signal } })),
  });

/** Where a new inbox goes; `password` and `servers` only on a domain on its own mail host. */
export interface InboxPlacement {
  domainId: string;
  localPart: string;
  password?: string;
  servers?: { imap: MailServer; smtp: MailServer };
}

function placementJson({ domainId, localPart, password, servers }: InboxPlacement) {
  return {
    domainId,
    localPart,
    ...(password && servers ? { login: { password, ...servers } } : {}),
  };
}

const settle = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.workspaceMembers() }),
    client.invalidateQueries({ queryKey: keys.workspaceMailboxes() }),
    client.invalidateQueries({ queryKey: keys.mailboxes() }),
    client.invalidateQueries({ queryKey: keys.workspaces() }),
    client.invalidateQueries({ queryKey: keys.onboarding() }),
    client.invalidateQueries({ queryKey: keys.invitations() }),
  ]);

/** A personal inbox for `memberId`; the issuer gets no access. Idempotent per address. */
export const issueInboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ memberId, ...placement }: InboxPlacement & { memberId: string }) =>
      call(
        api.workspace.members[":memberId"].inboxes.$post({
          param: { memberId },
          json: placementJson(placement),
        }),
      ),
    onSettled: () => settle(client),
  });

/** A shared inbox seen by exactly `memberIds`. Idempotent per address. */
export const createSharedInboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ memberIds, ...placement }: InboxPlacement & { memberIds: string[] }) =>
      call(
        api.workspace["shared-inboxes"].$post({
          json: { ...placementJson(placement), memberIds },
        }),
      ),
    onSettled: () => settle(client),
  });

/** Gives a former member's inbox to `memberId`: theirs from now on, old mail included. */
export const giveInboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ mailboxId, memberId }: { mailboxId: string; memberId: string }) =>
      call(
        api.workspace.inboxes[":id"].owner.$post({ param: { id: mailboxId }, json: { memberId } }),
      ),
    onSettled: () => settle(client),
  });

/** Turns a former member's inbox into a shared inbox seen by `memberIds`. */
export const shareInboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ mailboxId, memberIds }: { mailboxId: string; memberIds: string[] }) =>
      call(
        api.workspace.inboxes[":id"].shared.$post({
          param: { id: mailboxId },
          json: { memberIds },
        }),
      ),
    onSettled: () => settle(client),
  });

/** Removes an inbox from the workspace (its mail stays at the host). 204, so no body to parse. */
export const removeInboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (mailboxId: string) => {
      const response = await api.workspace.inboxes[":id"].$delete({ param: { id: mailboxId } });
      if (!response.ok) await call(Promise.resolve(response));
    },
    onSettled: () => settle(client),
  });

/** Invites `email` with a personal inbox (`inbox`) and/or shared inboxes to be on. */
export const inviteWithInboxMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (input: {
      email: string;
      role?: "member" | "admin";
      inbox?: InboxPlacement;
      sharedInboxIds?: string[];
    }) =>
      call(
        api.workspace.invitations.$post({
          json: {
            email: input.email,
            role: input.role ?? "member",
            ...(input.inbox ? { inbox: placementJson(input.inbox) } : {}),
            sharedInboxIds: input.sharedInboxIds ?? [],
          },
        }),
      ),
    onSettled: () => settle(client),
  });

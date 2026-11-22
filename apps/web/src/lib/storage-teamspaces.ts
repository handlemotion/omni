import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export type StorageTeamspace = InferResponseType<
  Api["storage"]["teamspaces"]["$get"],
  200
>["teamspaces"][number];
export type StorageTeamspaceMember = InferResponseType<
  Api["storage"]["teamspaces"][":id"]["members"]["$get"],
  200
>["members"][number];
export type StorageTeamspaceRole = StorageTeamspaceMember["role"];

/** The workspace's teamspaces the member reaches, by name. */
export const storageTeamspacesQuery = () =>
  queryOptions({
    queryKey: keys.storageTeamspaces(),
    queryFn: ({ signal }) => call(api.storage.teamspaces.$get(undefined, { init: { signal } })),
    select: (data) => data.teamspaces,
  });

/** Who is in a teamspace, owners first. */
export const storageTeamspaceMembersQuery = (teamspaceId: string) =>
  queryOptions({
    queryKey: keys.storageTeamspaceMembers(teamspaceId),
    queryFn: ({ signal }) =>
      call(
        api.storage.teamspaces[":id"].members.$get(
          { param: { id: teamspaceId } },
          { init: { signal } },
        ),
      ),
    select: (data) => data.members,
  });

const refreshTeamspaces = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: keys.storageTeamspaces() });

/** `mutate({ name, private, memberIds })`: a teamspace owned by the member. */
export const createTeamspaceMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (body: { name: string; private?: boolean; memberIds?: string[] }) =>
      call(api.storage.teamspaces.$post({ json: body })),
    onSuccess: () => refreshTeamspaces(client),
  });

/** `mutate({ id, name?, private? })`, for whoever manages it. */
export const updateTeamspaceMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...body }: { id: string; name?: string; private?: boolean }) =>
      call(api.storage.teamspaces[":id"].$patch({ param: { id }, json: body })),
    onSuccess: () => refreshTeamspaces(client),
  });

/** `mutate(id)`: the member joins an open teamspace. */
export const joinTeamspaceMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.storage.teamspaces[":id"].join.$post({ param: { id } })),
    onSuccess: () => refreshTeamspaces(client),
  });

/** `mutate(id)`: deletes a teamspace that holds nothing outside Trash. */
export const deleteTeamspaceMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.storage.teamspaces[":id"].$delete({ param: { id } })),
    onSuccess: () => refreshTeamspaces(client),
  });

/** `mutate({ id, memberId, role })` adds someone or changes their role; `role: null` removes them. */
export const putTeamspaceMemberMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({
      id,
      memberId,
      role,
    }: {
      id: string;
      memberId: string;
      role: StorageTeamspaceRole | null;
    }) =>
      role
        ? call(
            api.storage.teamspaces[":id"].members[":memberId"].$put({
              param: { id, memberId },
              json: { role },
            }),
          )
        : call(
            api.storage.teamspaces[":id"].members[":memberId"].$delete({
              param: { id, memberId },
            }),
          ),
    onSuccess: (data, { id }) => {
      client.setQueryData(keys.storageTeamspaceMembers(id), data);
      return refreshTeamspaces(client);
    },
  });

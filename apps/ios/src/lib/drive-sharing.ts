import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { config } from "./config.ts";
import { keys } from "./query-keys.ts";

export type DriveSharing = InferResponseType<
  Api["storage"]["nodes"][":id"]["sharing"]["$get"],
  200
>["sharing"];
export type DriveGrantRole = DriveSharing["people"][number]["role"];
export type DriveLinkAccess = DriveSharing["linkAccess"];
export type DriveVersions = InferResponseType<
  Api["storage"]["files"][":id"]["versions"]["$get"],
  200
>;

/** The web's role and access names, in its order. */
export const ROLES: { id: DriveGrantRole; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "commenter", label: "Commenter" },
  { id: "editor", label: "Editor" },
];
export const ACCESS: { id: DriveLinkAccess; label: string }[] = [
  { id: "restricted", label: "Restricted" },
  { id: "workspace", label: "People in this workspace" },
  { id: "anyone", label: "Anyone with the link" },
];
/** A change to a link's settings: expiry (null: never), password (null removes it), downloads. */
export type DriveLinkChange = {
  expiresAt?: string | null;
  password?: string | null;
  downloads?: boolean;
};
export const roleLabel = (role: DriveGrantRole) => ROLES.find((r) => r.id === role)?.label ?? role;
export const accessLabel = (access: DriveLinkAccess) =>
  ACCESS.find((a) => a.id === access)?.label ?? access;

/** The link to a shared item, as people open it: the web app's `/s/<shareId>` on the Worker. */
export const shareUrl = (shareId: string) => `${config.apiUrl}/s/${encodeURIComponent(shareId)}`;

/** Who has `nodeId`: people, those from a folder above it, and its link. */
export const useSharing = (nodeId: string) =>
  useQuery({
    queryKey: keys.driveSharing(nodeId),
    queryFn: ({ signal }) =>
      call(api.storage.nodes[":id"].sharing.$get({ param: { id: nodeId } }, { init: { signal } })),
  });

const sharingChanged =
  (client: QueryClient) =>
  ({ sharing }: { sharing: DriveSharing }) =>
    client.setQueryData(keys.driveSharing(sharing.nodeId), { sharing });

/**
 * `mutate({ id, linkAccess })` sets general access, `mutate({ id, reset: true })` makes a new
 * link, and `mutate({ id, ...change })` changes its settings.
 */
export function useSetLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...json
    }: { id: string } & ({ linkAccess: DriveLinkAccess } | { reset: true } | DriveLinkChange)) =>
      call(api.storage.nodes[":id"].sharing.link.$put({ param: { id }, json })),
    onSuccess: sharingChanged(client),
  });
}

/** `mutate({ id, email, role })` adds a person (they get one mail) or changes their role. */
export function usePutPerson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, email, role }: { id: string; email: string; role: DriveGrantRole }) =>
      call(
        api.storage.nodes[":id"].sharing.people[":email"].$put({
          param: { id, email },
          json: { role },
        }),
      ),
    onSuccess: sharingChanged(client),
  });
}

/** `mutate({ id, email })` removes a person; their next request finds nothing. */
export function useRemovePerson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) =>
      call(api.storage.nodes[":id"].sharing.people[":email"].$delete({ param: { id, email } })),
    onSuccess: sharingChanged(client),
  });
}

/** A file's content now and the versions kept before it, newest first. */
export const useVersions = (id: string) =>
  useQuery({
    queryKey: keys.driveVersions(id),
    queryFn: ({ signal }) =>
      call(api.storage.files[":id"].versions.$get({ param: { id } }, { init: { signal } })),
  });

/** `mutate({ id, versionId })` makes a kept version the file's content again. */
export function useRestoreVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, versionId }: { id: string; versionId: string }) =>
      call(
        api.storage.files[":id"].versions[":versionId"].restore.$post({ param: { id, versionId } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.driveAll() }),
  });
}

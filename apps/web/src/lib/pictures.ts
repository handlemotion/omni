import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

const settle = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.session() }),
    client.invalidateQueries({ queryKey: keys.deviceSessions() }),
    client.invalidateQueries({ queryKey: keys.org() }),
  ]);

/** Idempotent on the server (a PUT keyed by content), so a retry is safe without a key. */
export const uploadProfilePictureMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (file: File) => call(api.account.picture.$put({ form: { file } })),
    onSettled: () => settle(client),
  });

export const removeProfilePictureMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: () => call(api.account.picture.$delete()),
    onSettled: () => settle(client),
  });

/** Owners and admins of the active workspace only (403 otherwise). */
export const uploadWorkspaceLogoMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (file: File) => call(api.workspace.logo.$put({ form: { file } })),
    onSettled: () => settle(client),
  });

export const removeWorkspaceLogoMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: () => call(api.workspace.logo.$delete()),
    onSettled: () => settle(client),
  });

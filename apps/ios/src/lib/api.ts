import { expoClient } from "@better-auth/expo/client";
import { WORKSPACE_HEADER, createApi, createAuth, createCall, type Api } from "@omni/client";
import * as SecureStore from "./secure-store";
import { Platform } from "react-native";
import { config } from "./config.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

/** Where the auth client keeps the session: `<prefix>_cookie` in SecureStore. */
export const STORAGE_PREFIX = "omni";

export const auth = createAuth({
  baseUrl: config.apiUrl,
  plugins: [
    expoClient({ scheme: config.scheme, storagePrefix: STORAGE_PREFIX, storage: SecureStore }),
  ],
});

/**
 * Typed Hono RPC calls with the session attached, naming the app's workspace. Prefer `call()` to
 * unwrap them.
 */
export const api: Api = createApi({
  baseUrl: config.apiUrl,
  headers: () => {
    const headers: Record<string, string> = {};
    const workspace = currentWorkspaceId();
    if (workspace) headers[WORKSPACE_HEADER] = workspace;
    return headers;
  },
  fetch: async (input, init) => {
    if (Platform.OS === "web") return fetch(input, { ...init, credentials: "include" });
    const headers = new Headers(init?.headers);
    const cookie = await auth.getCookie();
    if (cookie) headers.set("cookie", cookie);
    return fetch(input, { ...init, headers, credentials: "omit" });
  },
});

/**
 * Request options that name `workspace` on a call, whatever the app is in when it runs: a mutation
 * captures the workspace when the person acts, so a retry after they switch still lands there.
 */
export function inWorkspace(workspace: string | null) {
  return workspace ? { headers: { [WORKSPACE_HEADER]: workspace } } : {};
}

/** Awaits a Hono RPC call and returns its typed body, or throws `ApiError`. */
export const call = createCall();

export { ApiError, isAuthError, isNotFound } from "@omni/client";

/**
 * The session and the workspace, for a request the app makes outside `call()`: a download, an
 * upload, an image the system loads.
 */
export async function sessionHeaders(workspace = currentWorkspaceId()) {
  const headers: Record<string, string> = {};
  const cookie = await auth.getCookie();
  if (cookie) headers.cookie = cookie;
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  return headers;
}

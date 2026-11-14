// The app's one API and auth client, from `@omni/client` like the web app's. Native requests
// carry the session the auth client keeps in the Keychain (SecureStore) as a `Cookie` header.
import { expoClient } from "@better-auth/expo/client";
import { createApi, createAuth } from "@omni/client";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { DetailedError, parseResponse, type ClientResponse } from "hono/client";
import { config } from "./config.ts";

/** Where the auth client keeps the session: `<prefix>_cookie` in SecureStore. */
export const STORAGE_PREFIX = "omni";

export const auth = createAuth({
  baseUrl: config.apiUrl,
  plugins: [
    expoClient({ scheme: config.scheme, storagePrefix: STORAGE_PREFIX, storage: SecureStore }),
  ],
});

/** Typed Hono RPC calls with the session attached. Prefer `call()` to unwrap them. */
export const api = createApi({
  baseUrl: config.apiUrl,
  fetch: async (input, init) => {
    // In a browser (Expo's web target) the session is a first-party cookie, as for the web app.
    if (Platform.OS === "web") return fetch(input, { ...init, credentials: "include" });
    const headers = new Headers(init?.headers);
    const cookie = await auth.getCookie();
    if (cookie) headers.set("cookie", cookie);
    // The cookie is ours to send; the OS cookie store must not add or keep one.
    return fetch(input, { ...init, headers, credentials: "omit" });
  },
});

/** A failed API call. `status` 0 means the request never got an answer (offline, aborted). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Awaits a Hono RPC call and returns its typed body, or throws `ApiError`. */
// oxlint-disable-next-line typescript/no-explicit-any -- mirrors hono's own `parseResponse` bound
export async function call<T extends ClientResponse<any>>(
  request: Promise<T>,
): ReturnType<typeof parseResponse<T>> {
  try {
    return await parseResponse(request);
  } catch (error) {
    if (error instanceof DetailedError) {
      const data = (error.detail as { data?: unknown } | undefined)?.data;
      const message =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : error.message;
      throw new ApiError(Number(error.statusCode ?? 0), message);
    }
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }
}

/** True for "not signed in" or "not a member": retrying will not help. */
export function isAuthError(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

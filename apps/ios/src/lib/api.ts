import { expoClient } from "@better-auth/expo/client";
import {
  WORKSPACE_HEADER,
  createApi,
  createAuth,
  toApiError,
  type ApiErrorInfo,
} from "@omni/client";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { DetailedError, parseResponse, type ClientResponse } from "hono/client";
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
export const api = createApi({
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
 * A failed API call. `status` 0 means the request never got an answer (offline, aborted). The
 * rest is what the Worker said (ADR 0038), when it said it: `code` is stable, the message is not.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly category?: string;
  readonly retryable?: boolean;
  readonly requestId?: string;
  readonly param?: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, message: string, info: Omit<ApiErrorInfo, "message"> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = info.code;
    this.category = info.category;
    this.retryable = info.retryable;
    this.requestId = info.requestId;
    this.param = info.param;
    this.details = info.details;
  }
}

/** Awaits a Hono RPC call and returns its typed body, or throws `ApiError`. */
// oxlint-disable-next-line typescript/no-explicit-any -- mirrors hono's own `parseResponse` bound
export const call: <T extends ClientResponse<any>>(
  request: Promise<T>,
) => ReturnType<typeof parseResponse<T>> = async (request) => {
  try {
    return await parseResponse(request);
  } catch (error) {
    if (error instanceof DetailedError) {
      const data = (error.detail as { data?: unknown } | undefined)?.data;
      const { message, ...info } = toApiError(data, error.message);
      throw new ApiError(Number(error.statusCode ?? 0), message, info);
    }
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }
};

/** True for "not signed in" or "not a member": retrying will not help. */
export function isAuthError(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

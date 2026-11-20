import { createApi, createAuth, toApiError, type Api, type ApiErrorInfo } from "@omni/client";
import { DetailedError, parseResponse, type ClientResponse } from "hono/client";
import { reportAnswer, reportNoAnswer } from "./connectivity.ts";
import { workspaceHeaders } from "./current-workspace.ts";
import { takeStartupResponse } from "./startup-fetch.ts";
import { tracedFetch } from "./telemetry.ts";

const origin = window.location.origin;

/** Typed Hono RPC calls: `api.threads.$get({ query })`. Prefer `call()` to unwrap them. */
export const api: Api = createApi({
  baseUrl: origin,
  headers: workspaceHeaders,
  fetch: (input, init) => takeStartupResponse(input, init) ?? tracedFetch(input, init),
});

/** Better Auth's client: magic link, passkeys, organizations. */
export const auth = createAuth({
  baseUrl: origin,
  fetch: (input, init) => takeStartupResponse(input, init) ?? fetch(input, init),
});

/**
 * A failed API call. `status` 0 means the request never got an answer (offline, aborted). The
 * rest is what the Worker said, when it said it: `code` is stable, the message is not.
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

/**
 * Awaits a Hono RPC call and returns its typed success body, or throws `ApiError` with what
 * the Worker said, in either error shape. Pass `{ init: { signal } }` to the call so a cancelled query
 * aborts the request.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- mirrors hono's own `parseResponse` bound
export const call: <T extends ClientResponse<any>>(
  request: Promise<T>,
) => ReturnType<typeof parseResponse<T>> = async (request) => {
  try {
    const body = await parseResponse(request);
    reportAnswer();
    return body;
  } catch (error) {
    if (error instanceof DetailedError) {
      reportAnswer();
      const data = (error.detail as { data?: unknown } | undefined)?.data;
      const { message, ...info } = toApiError(data, error.message);
      throw new ApiError(Number(error.statusCode ?? 0), message, info);
    }
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    reportNoAnswer();
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }
};

/** True for errors that mean "not signed in" or "not a member": retrying will not help. */
export function isAuthError(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * One key per user intent. Mutating routes require it, and a retry of the same intent must
 * reuse it so the outbox never runs the action twice.
 */
export function idempotencyKey() {
  return crypto.randomUUID();
}

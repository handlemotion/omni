// The app's one API and auth client. The Worker serves this app and `/api` on the same origin
// (ADR 0006), so the session cookie is first-party and there is nothing to configure.
import { createApi, createAuth } from "@omni/client";
import { DetailedError, parseResponse, type ClientResponse } from "hono/client";
import { reportAnswer, reportNoAnswer } from "./connectivity.ts";
import { tracedFetch } from "./telemetry.ts";

const origin = window.location.origin;

/** Typed Hono RPC calls: `api.threads.$get({ query })`. Prefer `call()` to unwrap them. */
export const api = createApi({ baseUrl: origin, fetch: tracedFetch });

/** Better Auth's client: magic link, passkeys, organizations. */
export const auth = createAuth({ baseUrl: origin });

/** A failed API call. `status` 0 means the request never got an answer (offline, aborted). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Awaits a Hono RPC call and returns its typed success body, or throws `ApiError` with the
 * Worker's `{ error }` message. Pass `{ init: { signal } }` to the call so a cancelled query
 * aborts the request.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- mirrors hono's own `parseResponse` bound
export async function call<T extends ClientResponse<any>>(
  request: Promise<T>,
): ReturnType<typeof parseResponse<T>> {
  try {
    const body = await parseResponse(request);
    reportAnswer();
    return body;
  } catch (error) {
    if (error instanceof DetailedError) {
      reportAnswer();
      const data = (error.detail as { data?: unknown } | undefined)?.data;
      const message =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : error.message;
      throw new ApiError(Number(error.statusCode ?? 0), message);
    }
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    reportNoAnswer();
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }
}

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

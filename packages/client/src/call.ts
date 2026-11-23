import { toApiError, type ApiErrorInfo } from "@omni/contracts/errors";
import { DetailedError, parseResponse, type ClientResponse } from "hono/client";

/**
 * A failed API call. `status` 0 means the request never got an answer (offline, dropped). The
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
  /** When a 429's window resets (ms since the epoch), from the Worker's `limit`. */
  readonly retryAt?: number;
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
    this.retryAt = info.limit?.resetMs;
  }
}

/** Awaits a Hono RPC call and returns its typed success body, or throws `ApiError`. */
// oxlint-disable-next-line typescript/no-explicit-any -- mirrors hono's own `parseResponse` bound
export type Call = <T extends ClientResponse<any>>(
  request: Promise<T>,
) => ReturnType<typeof parseResponse<T>>;

export interface CallHooks {
  /** The Worker answered, with a success or an error. */
  onAnswer?: () => void;
  /** The request got no answer at all. Not called for a cancelled request. */
  onNoAnswer?: () => void;
}

const isAbort = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

/**
 * The app's `call`: what the Worker said, in either error shape, as `ApiError`. A cancelled
 * request (`{ init: { signal } }`) rethrows its abort as is, so it never reads as a retryable
 * `ApiError(0)`.
 */
export const createCall = (hooks: CallHooks = {}) => {
  const call: Call = async (request) => {
    try {
      const body = await parseResponse(request);
      hooks.onAnswer?.();
      return body;
    } catch (error) {
      if (error instanceof DetailedError) {
        hooks.onAnswer?.();
        const data = (error.detail as { data?: unknown } | undefined)?.data;
        const { message, ...info } = toApiError(data, error.message);
        throw new ApiError(Number(error.statusCode ?? 0), message, info);
      }
      if (isAbort(error)) throw error;
      hooks.onNoAnswer?.();
      throw new ApiError(0, error instanceof Error ? error.message : String(error));
    }
  };
  return call;
};

/** "Not signed in" or "not a member": retrying will not help. */
export const isAuthError = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

/** The record is gone (deleted, or never there). */
export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/** A request that never reached the server: offline, or the connection dropped. */
export const isUnreached = (error: unknown) => error instanceof ApiError && error.status === 0;

/** A failure the same request may get past: no answer, a timeout, a rate limit, a server error. */
export const isTransient = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);

/** A query or mutation `retry` that tries again only while the server is unreached. */
export const retryUnreached = (limit: number) => (failureCount: number, error: Error) =>
  isUnreached(error) && failureCount < limit;

/** The stable `code` of a failure (`ApiError` or anything carrying one), if it has one. */
export const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Mutating routes require this header. One key per user intent: a retry of the same intent
 * reuses it, so the outbox never runs the action twice.
 */
export const IDEMPOTENCY_HEADER = "idempotency-key";

export const idempotencyHeader = (key: string) => ({ [IDEMPOTENCY_HEADER]: key });

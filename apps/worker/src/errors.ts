import {
  codeForStatus,
  ERROR_CODES,
  ERROR_FORMAT_HEADER,
  ERROR_FORMAT_VERSION,
  legacyCode,
  type ErrorBodyV2,
  type ErrorCode,
  type LegacyErrorBody,
  type RateLimitInfo,
} from "@omni/contracts";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";
import { createLogger } from "./log.ts";

export interface ErrorExtras {
  /** The first offending field of a validation error. */
  param?: string;
  details?: Record<string, unknown>;
  limit?: RateLimitInfo;
}

/** A refusal with a code of its own, thrown from deep inside a route; `onError` answers it. */
export class ApiFailure extends Error {
  override name = "ApiFailure";
  readonly code: ErrorCode;
  readonly extras: ErrorExtras;
  constructor(code: ErrorCode, message: string, extras: ErrorExtras = {}) {
    super(message);
    this.code = code;
    this.extras = extras;
  }
}

function wantsNestedErrors(c: Context) {
  return c.req.header(ERROR_FORMAT_HEADER) === ERROR_FORMAT_VERSION;
}

/**
 * The body alone, for a response that carries data beside its error (a draft conflict keeps the
 * teammate's `draft` at the top level in both shapes).
 */
export function errorBody(
  c: Context<AppEnv>,
  code: ErrorCode,
  message: string,
  extras: ErrorExtras = {},
) {
  const { category, retryable } = ERROR_CODES[code];
  const fields = { category, retryable, requestId: c.var.requestId, ...extras };
  if (wantsNestedErrors(c))
    return { error: { code, message, ...fields } } satisfies ErrorBodyV2 | LegacyErrorBody;
  return { error: message, code: legacyCode(code), ...fields } satisfies
    | ErrorBodyV2
    | LegacyErrorBody;
}

/** The error answer for `code`, with its status from the table. */
export function apiError(
  c: Context<AppEnv>,
  code: ErrorCode,
  message: string,
  extras: ErrorExtras = {},
) {
  return c.json(errorBody(c, code, message, extras), ERROR_CODES[code].status);
}

/** `app.onError`: every thrown refusal gets its code here; anything else is a 500 that says nothing. */
export function answerThrown(error: Error, c: Context<AppEnv>) {
  if (error instanceof ApiFailure) return apiError(c, error.code, error.message, error.extras);
  if (error instanceof HTTPException) {
    return apiError(c, codeForStatus(error.status), error.message);
  }
  (c.var.log ?? createLogger()).error("http.error", { error, orgId: c.var.member?.orgId });
  return apiError(c, "internal_server_error", "internal error");
}

/** Refuses with 404: the resource is missing or the member may not see it, alike. */
export function notFound(): never {
  throw new HTTPException(404, { message: "not found" });
}

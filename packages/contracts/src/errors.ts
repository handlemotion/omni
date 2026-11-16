// The Worker's error answers (ADR 0038). A client that sends `omni-error-format: 2` gets the
// nested shape, `{ error: { code, message, category, retryable, requestId, ... } }`; any other
// request gets the legacy one, `{ error: "<message>", code, requestId, ... }`, which web tabs and
// iOS builds from before ADR 0038 read. Better Auth (`/api/auth/*`) and MCP keep their own.
// No zod here: clients import this from `@omni/contracts/errors` into the web app's entry chunk,
// which stays free of full zod. The zod schemas of both shapes are in `error-schemas.ts`.

/** Sent by a client that reads the nested shape. Any other value, or none, gets the legacy one. */
export const ERROR_FORMAT_HEADER = "omni-error-format";
export const ERROR_FORMAT_VERSION = "2";

export const ERROR_CATEGORIES = [
  "validation",
  "unauthenticated",
  "permission",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limit",
  "quota",
  "billing",
  "unavailable",
  "internal",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

interface ErrorSpec {
  status:
    | 400
    | 401
    | 402
    | 403
    | 404
    | 409
    | 410
    | 411
    | 413
    | 415
    | 422
    | 426
    | 429
    | 500
    | 502
    | 504;
  category: ErrorCategory;
  /** The same request may succeed later, unchanged. */
  retryable: boolean;
}

const spec = (status: ErrorSpec["status"], category: ErrorCategory, retryable = false) => ({
  status,
  category,
  retryable,
});

/**
 * Every code the Worker answers, with its one status and category. Generic codes first: a
 * refusal without a code of its own gets the generic code of its status (`codeForStatus`).
 */
export const ERROR_CODES = {
  bad_request: spec(400, "validation"),
  unauthorized: spec(401, "unauthenticated"),
  forbidden: spec(403, "permission"),
  not_found: spec(404, "not_found"),
  conflict: spec(409, "conflict"),
  gone: spec(410, "not_found"),
  length_required: spec(411, "validation"),
  payload_too_large: spec(413, "payload_too_large"),
  unsupported_media_type: spec(415, "validation"),
  unprocessable_entity: spec(422, "validation"),
  upgrade_required: spec(426, "validation"),
  rate_limited: spec(429, "rate_limit", true),
  internal_server_error: spec(500, "internal"),
  bad_gateway: spec(502, "unavailable", true),
  gateway_timeout: spec(504, "unavailable", true),
  // Billing (ADR 0015): the workspace has no plan in good standing.
  billing_inactive: spec(402, "billing"),
  billing_required: spec(402, "billing"),
  // Storage (ADR 0034).
  storage_full: spec(402, "quota"),
  file_too_large: spec(413, "payload_too_large"),
  invalid_name: spec(400, "validation"),
  invalid_email: spec(400, "validation"),
  /** The part's number or length is not the one the upload expects. */
  invalid_part: spec(400, "validation"),
  name_taken: spec(409, "conflict"),
  too_deep: spec(409, "conflict"),
  cycle: spec(409, "conflict"),
  parent_trashed: spec(409, "conflict"),
  not_trashed: spec(409, "conflict"),
  /**
   * A locked file, or a folder holding one, cannot be renamed, moved, trashed or deleted, and a
   * locked file's content cannot be replaced.
   */
  locked: spec(409, "conflict"),
  /** The parts sent so far do not add up to the file. */
  upload_incomplete: spec(409, "conflict"),
  /** The upload already became a file. */
  upload_complete: spec(409, "conflict"),
  /** A guarded write (`ifRevision`, `ifContentVersion`) read a node that has changed since. */
  version_conflict: spec(409, "conflict"),
  /** Only a PDF is sent for signature (ADR 0043 decision 6). */
  not_a_pdf: spec(415, "validation"),
  /** The file is already out for signature: void that request before sending it again. */
  signature_open: spec(409, "conflict"),
  /** The request was completed or voided: nothing more is signed or voided on it. */
  signature_closed: spec(409, "conflict"),
  already_signed: spec(409, "conflict"),
  /** The one-time code is wrong, used up or expired: ask for a new one. */
  invalid_code: spec(400, "validation"),
  /** The consent sentence changed since the signer read it: show it again. */
  consent_changed: spec(409, "conflict"),
  /** A sync cursor older than tombstone retention: enumerate the drive again from the start. */
  cursor_expired: spec(410, "not_found"),
  // CRM (ADR 0036).
  /** A Personal space has no CRM. */
  no_crm: spec(404, "not_found"),
  /** Another person holds the address; `personId` beside the error names them. */
  address_taken: spec(409, "conflict"),
  /** Another company holds the domain; `companyId` beside the error names it. */
  domain_taken: spec(409, "conflict"),
  /** gmail.com and the like are never a company's domain. */
  webmail_domain: spec(400, "validation"),
  /** A stage left out of the pipeline still holds deals; `stageIds` beside the error. */
  stage_in_use: spec(409, "conflict"),
  /** Each stage kind keeps at least one stage; `kinds` beside the error names the missing. */
  stage_kind_required: spec(409, "conflict"),
  /** Not an ISO 4217 code, or a value with no currency and no workspace default. */
  invalid_currency: spec(400, "validation"),
  /**
   * A signed contract keeps its status, its document and its row, and the company or deal that
   * holds one is not deleted for good.
   */
  contract_signed: spec(409, "conflict"),
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;
export type ErrorStatus = ErrorSpec["status"];
export const errorCodes = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

const BY_STATUS = new Map<number, ErrorCode>();
for (const [code, { status }] of Object.entries(ERROR_CODES) as [ErrorCode, ErrorSpec][]) {
  if (!BY_STATUS.has(status)) BY_STATUS.set(status, code);
}

/** The generic code for a status; an unknown one reads as an internal error. */
export function codeForStatus(status: number): ErrorCode {
  return BY_STATUS.get(status) ?? "internal_server_error";
}

/** A rate limit's state when the Worker refused: Vercel's `limit` object. */
export interface RateLimitInfo {
  remaining: number;
  /** Unix seconds when the window resets. */
  reset: number;
  resetMs: number;
  total?: number;
}

/** What a client knows of a failed call, from either shape. */
export interface ApiErrorInfo {
  message: string;
  /** A code from `ERROR_CODES`, or one a newer Worker added. */
  code?: string;
  category?: string;
  retryable?: boolean;
  requestId?: string;
  param?: string;
  details?: Record<string, unknown>;
  limit?: RateLimitInfo;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FIELDS = { string: ["code", "category", "requestId", "param"], boolean: ["retryable"] };

/** The fields of `source` that have their declared type; anything else is dropped. */
function pick(source: Record<string, unknown>): Omit<ApiErrorInfo, "message"> {
  const info: Record<string, unknown> = {};
  for (const key of FIELDS.string) if (typeof source[key] === "string") info[key] = source[key];
  for (const key of FIELDS.boolean) if (typeof source[key] === "boolean") info[key] = source[key];
  for (const key of ["details", "limit"]) if (isRecord(source[key])) info[key] = source[key];
  return info;
}

/**
 * A code as the legacy shape spells it: upper case, as codes shipped before this format
 * (`STORAGE_FULL`), so tabs opened before it keep matching the codes they know.
 */
export const legacyCode = (code: ErrorCode) => code.toUpperCase();

/**
 * Reads an error body in either shape, checked by hand; `fallback` is the message when the body
 * is neither (a proxy's HTML page, an empty body). The code always comes back in lower case,
 * whichever shape carried it.
 */
export function toApiError(body: unknown, fallback: string): ApiErrorInfo {
  if (!isRecord(body)) return { message: fallback };
  const { error } = body;
  if (isRecord(error) && typeof error.message === "string") {
    return { ...pick(error), message: error.message };
  }
  if (typeof error === "string") {
    const info = pick(body);
    if (info.code) info.code = info.code.toLowerCase();
    return { ...info, message: error };
  }
  return { message: fallback };
}

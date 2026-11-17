// What went wrong, in the few kinds the app handles differently (ADR 0046). Every caught failure
// (a route's loader or render, a lazy chunk, a query, a mutation) goes through `classify`, and
// boundaries, toasts and retries decide on the kind, never on a message. API failures keep the
// Worker's own taxonomy (ADR 0038): its category picks the kind, its code and request ID ride along.
import * as Sentry from "@sentry/browser";
import { onlineManager } from "@tanstack/react-query";
import { ApiError } from "./api.ts";

export type FailureKind =
  /** Code or an asset from a build that is no longer deployed: reloading gets the current one. */
  | "stale_build"
  /** No answer at all: offline, or the server unreachable. */
  | "offline"
  /** The session ended. */
  | "unauthenticated"
  /** Signed in, but not allowed here. */
  | "permission"
  /** The thing is gone or never existed. */
  | "not_found"
  /** The request was refused as it stands: validation, conflict, quota, billing, too large. */
  | "refused"
  /** Too many requests; `retryable`. */
  | "rate_limit"
  /** The server or something behind it is down for now; `retryable`. */
  | "unavailable"
  /** The server failed: a 500. */
  | "server"
  /** Our own code threw: a render or logic error. */
  | "bug";

/** A classified failure, tagged like Effect's `Data.TaggedError` so a `switch` on `kind` is exhaustive. */
export interface Failure {
  readonly kind: FailureKind;
  /** The same action may succeed later, unchanged. */
  readonly retryable: boolean;
  /** The Worker's stable code (ADR 0038), when the failure came from the API. */
  readonly code?: string;
  /** Shown on the error page and attached to reports, so a person can quote it. */
  readonly requestId?: string;
  readonly cause: unknown;
}

// Each engine words a failed dynamic import or module script differently; a stale chunk that the
// server answered with HTML shows up as the MIME type message.
const STALE_BUILD = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Failed to load module script/i, // Chromium, a module answered with the wrong MIME type
  /is not a valid JavaScript MIME type/i,
  /Unable to preload CSS/i, // Vite's CSS preload
  /Loading (CSS )?chunk [\w-]+ failed/i,
];

export function isStaleBuild(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return STALE_BUILD.some((pattern) => pattern.test(message));
}

const BY_CATEGORY: Record<string, FailureKind> = {
  validation: "refused",
  unauthenticated: "unauthenticated",
  permission: "permission",
  not_found: "not_found",
  conflict: "refused",
  payload_too_large: "refused",
  rate_limit: "rate_limit",
  quota: "refused",
  billing: "refused",
  unavailable: "unavailable",
  internal: "server",
};

const byStatus: (status: number) => FailureKind = (status) => {
  if (status === 0) return "offline";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  if (status >= 500) return "server";
  return "refused";
};

const fromApi: (error: ApiError) => Failure = (error) => {
  const kind = (error.category && BY_CATEGORY[error.category]) || byStatus(error.status);
  const retryable =
    error.retryable ?? (kind === "offline" || kind === "rate_limit" || kind === "unavailable");
  return { kind, retryable, code: error.code, requestId: error.requestId, cause: error };
};

/** The one place a thrown value becomes a `Failure`. */
export const classify: (error: unknown) => Failure = (error) => {
  if (error instanceof ApiError) return fromApi(error);
  if (isStaleBuild(error)) return { kind: "stale_build", retryable: true, cause: error };
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return { kind: "offline", retryable: true, cause: error };
  }
  return { kind: "bug", retryable: false, cause: error };
};

/** The Worker's message as a sentence: it writes them in lower case ("this name is taken"). */
function sentence(cause: unknown) {
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message ? message.charAt(0).toUpperCase() + message.slice(1) : null;
}

/**
 * The toast for a failed action that nobody handled itself (`lib/query-client.ts`), by kind:
 * short and plain. A refusal says the Worker's own sentence. Null where something else already
 * speaks (the sign-in redirect, the reload).
 */
export function failureMessage(failure: Failure) {
  switch (failure.kind) {
    case "offline":
      return "You're offline.";
    case "unauthenticated":
    case "stale_build":
      return null;
    case "permission":
      return "You don't have access to that.";
    case "not_found":
      return "That's no longer here.";
    case "refused":
      return sentence(failure.cause) ?? "That didn't go through.";
    case "rate_limit":
      return "Too many at once. Try again in a minute.";
    case "unavailable":
      return "That's unavailable right now. Try again soon.";
    case "server":
      return "Something went wrong. Try again.";
    case "bug":
      return "Something went wrong.";
  }
}

const RELOADED_AT = "omni:reloaded-for-update";
/** A second stale-build failure this soon after reloading is not a deploy: stop, don't loop. */
const RELOAD_WINDOW_MS = 60_000;

/** Set once a reload is under way: what fails while the page goes away is not worth reporting. */
let reloading = false;

/**
 * Reloads once to pick up the deployed build. False when it reloaded within the last minute, so
 * the caller shows the error page instead of looping, and when offline, where a reload would
 * land on the browser's own error page.
 */
export function reloadForUpdate() {
  if (!onlineManager.isOnline()) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // No storage (a locked-down webview): without the guard a chunk that stays missing would
    // reload forever, so the failure goes to the error page, whose Reload button still works.
    return false;
  }
  reloading = true;
  window.location.reload();
  return true;
}

/**
 * Sends what nobody expected to Sentry (when the build has a DSN): bugs and server errors. Safe
 * to call for one failure from two layers (a query and the route that loaded it): Sentry marks
 * the error object and sends it once.
 */
export function reportFailure(failure: Failure) {
  if (reloading || (failure.kind !== "bug" && failure.kind !== "server")) return;
  Sentry.captureException(failure.cause, {
    tags: {
      failure_kind: failure.kind,
      ...(failure.requestId && { request_id: failure.requestId }),
    },
  });
}

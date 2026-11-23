import { createApi, createAuth, createCall, type Api } from "@omni/client";
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

export { ApiError } from "@omni/client";

/**
 * Awaits a Hono RPC call and returns its typed success body, or throws `ApiError`. Pass
 * `{ init: { signal } }` to the call so a cancelled query aborts the request.
 */
export const call = createCall({ onAnswer: reportAnswer, onNoAnswer: reportNoAnswer });

/**
 * One key per user intent. Mutating routes require it, and a retry of the same intent must
 * reuse it so the outbox never runs the action twice.
 */
export function idempotencyKey() {
  return crypto.randomUUID();
}

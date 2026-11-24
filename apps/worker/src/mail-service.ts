import { signedPost } from "@omni/crypto";
import { MAIL_PING_PATH } from "@omni/contracts";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";

/** The calling request's config and trace: its ID rides the signed headers to the mail service. */
export interface MailServiceScope {
  config: Config;
  requestId: string;
  log: Logger;
}

async function post(
  scope: MailServiceScope,
  path: string,
  json: string | undefined,
  timeoutMs: number,
) {
  const { url, init } = await signedPost({
    secret: scope.config.MAIL_SERVICE_HMAC_SECRET,
    baseUrl: scope.config.MAIL_SERVICE_URL,
    path,
    json,
    requestId: scope.requestId,
  });
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Tells the mail service the outbox has work. Best effort: the action is already in
 * `mail_actions` and the mail service polls it, so a lost ping only delays the action.
 */
export async function pingMailService(scope: MailServiceScope) {
  const log = scope.log.child({ component: "mail-service" });
  const started = Date.now();
  try {
    const response = await post(scope, MAIL_PING_PATH, undefined, 10_000);
    const durationMs = Date.now() - started;
    if (response.ok) log.info("mail_service.ping", { status: response.status, durationMs });
    else log.warn("mail_service.ping_failed", { status: response.status, durationMs });
    return response.ok;
  } catch (error) {
    log.warn("mail_service.ping_failed", { error, durationMs: Date.now() - started });
    return false;
  }
}

/**
 * The mail service refused or failed a call; `status` is what the Worker answers with. It is an
 * `HTTPException`, so a route that lets it through answers it like any other refusal.
 */
export class MailServiceError extends HTTPException {
  override name = "MailServiceError";
  declare readonly status: 400 | 409 | 422 | 502;
  constructor(status: 400 | 409 | 422 | 502, message: string) {
    super(status, { message });
  }
}

/**
 * A signed JSON call to the mail service that waits for its answer (onboarding's provisioning).
 * Each carries a fresh nonce, which the mail service accepts once. Its own refusals (400, 409,
 * 422, 502) pass through with their message; anything else reads as the service being down.
 */
export async function callMailService<S extends z.ZodType>(
  scope: MailServiceScope,
  path: string,
  body: unknown,
  result: S,
) {
  const log = scope.log.child({ component: "mail-service", path });
  const started = Date.now();
  let response: Response;
  try {
    response = await post(scope, path, JSON.stringify(body), 60_000);
  } catch (error) {
    log.warn("mail_service.call_failed", { error, durationMs: Date.now() - started });
    throw new MailServiceError(502, "Wok could not reach its mail service. Try again in a minute.");
  }
  const json = (await response.json().catch(() => null)) as { error?: unknown } | null;
  log.info("mail_service.call", { status: response.status, durationMs: Date.now() - started });
  if (!response.ok) {
    const passed = [400, 409, 422, 502] as const;
    const status = passed.find((s) => s === response.status);
    if (status && typeof json?.error === "string") throw new MailServiceError(status, json.error);
    log.warn("mail_service.call_refused", { status: response.status });
    throw new MailServiceError(502, "Wok's mail service could not do that. Try again in a minute.");
  }
  const parsed = result.safeParse(json);
  if (!parsed.success)
    throw new MailServiceError(
      502,
      "Wok's mail service answered unexpectedly. Try again in a minute.",
    );
  return parsed.data satisfies z.output<S>;
}

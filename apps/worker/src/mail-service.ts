import { signRequest } from "@omni/crypto";
import { MAIL_PING_PATH } from "@omni/contracts";
import type { z } from "zod";
import type { Config } from "./env.ts";

/**
 * Tells the mail service the outbox has work. Best effort: the action is already in
 * `mail_actions` and the mail service polls it, so a lost ping only delays the action.
 */
export async function pingMailService(config: Config): Promise<boolean> {
  const url = new URL(MAIL_PING_PATH, config.MAIL_SERVICE_URL);
  try {
    const headers = await signRequest({
      secret: config.MAIL_SERVICE_HMAC_SECRET,
      method: "POST",
      path: url.pathname + url.search,
      body: "",
    });
    const response = await fetch(url, { method: "POST", headers, body: "" });
    if (!response.ok) console.warn(`mail service ping failed: ${response.status}`);
    return response.ok;
  } catch (error) {
    console.warn(`mail service ping failed: ${String(error)}`);
    return false;
  }
}

/** The mail service refused or failed a call; `status` is what the Worker answers with. */
export class MailServiceError extends Error {
  override name = "MailServiceError";
  readonly status: 400 | 409 | 422 | 502;
  constructor(status: 400 | 409 | 422 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A signed JSON call to the mail service that waits for its answer (onboarding's provisioning).
 * Each carries a fresh nonce, which the mail service accepts once. Its own refusals (400, 409,
 * 422, 502) pass through with their message; anything else reads as the service being down.
 */
export async function callMailService<S extends z.ZodType>(
  config: Config,
  path: string,
  body: unknown,
  result: S,
): Promise<z.output<S>> {
  const url = new URL(path, config.MAIL_SERVICE_URL);
  const text = JSON.stringify(body);
  const headers = await signRequest({
    secret: config.MAIL_SERVICE_HMAC_SECRET,
    method: "POST",
    path: url.pathname + url.search,
    body: text,
    nonce: crypto.randomUUID().replaceAll("-", ""),
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: text,
      // Purelymail calls inside can take a few seconds each.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.warn(`mail service call ${path} failed: ${String(error)}`);
    throw new MailServiceError(502, "the mail service is unreachable");
  }
  const json = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const passed = [400, 409, 422, 502] as const;
    const status = passed.find((s) => s === response.status);
    if (status && typeof json?.error === "string") throw new MailServiceError(status, json.error);
    console.warn(`mail service call ${path} answered ${response.status}`);
    throw new MailServiceError(502, "the mail service could not do that");
  }
  const parsed = result.safeParse(json);
  if (!parsed.success) throw new MailServiceError(502, "the mail service answered unexpectedly");
  return parsed.data;
}

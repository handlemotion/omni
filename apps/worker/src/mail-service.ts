import { signRequest } from "@omni/crypto";
import { MAIL_PING_PATH } from "@omni/contracts";
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

// Optional Purelymail admin API (https://news.purelymail.com/api/index.html). Only used when a
// mailbox's provider is `purelymail` and a PURELYMAIL_API_TOKEN is configured; plain IMAP/SMTP
// never needs it.
import type { ServerEndpoint } from "../mailbox-connection.ts";

export const PURELYMAIL_SERVERS: { imap: ServerEndpoint; smtp: ServerEndpoint } = {
  imap: { host: "imap.purelymail.com", port: 993, secure: true },
  smtp: { host: "smtp.purelymail.com", port: 465, secure: true },
};

const API_BASE = "https://purelymail.com/api/v0";

export class PurelymailError extends Error {
  override name = "PurelymailError";
}

export interface PurelymailClient {
  /** A new app password for `userHandle` (`user@domain`). Shown once; store it encrypted. */
  createAppPassword(userHandle: string, name: string): Promise<string>;
}

export function createPurelymailClient(token: string, fetchImpl = fetch): PurelymailClient {
  async function call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetchImpl(`${API_BASE}/${method}`, {
      method: "POST",
      headers: { "Purelymail-Api-Token": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as {
      result?: T;
      code?: string;
      message?: string;
    } | null;
    if (!response.ok || !json || json.result === undefined) {
      // The error body carries a code and a message, never the token.
      throw new PurelymailError(
        `${method} failed (${response.status}): ${json?.code ?? "unknown"} ${json?.message ?? ""}`.trim(),
      );
    }
    return json.result;
  }

  return {
    async createAppPassword(userHandle, name) {
      const result = await call<{ appPassword?: string }>("createAppPassword", {
        userHandle,
        name,
      });
      if (!result.appPassword) throw new PurelymailError("createAppPassword returned no password");
      return result.appPassword;
    },
  };
}

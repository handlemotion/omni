// Optional Purelymail admin API. Methods and fields follow the published OpenAPI schema
// (https://news.purelymail.com/api/swagger-spec.js): every call is `POST /api/v0/<method>` with a
// JSON body, answering `{ result }`. Used only when PURELYMAIL_API_TOKEN is configured; plain
// IMAP/SMTP never needs it.
import type { ServerEndpoint } from "../mailbox-connection.ts";

export const PURELYMAIL_SERVERS: { imap: ServerEndpoint; smtp: ServerEndpoint } = {
  imap: { host: "imap.purelymail.com", port: 993, secure: true },
  smtp: { host: "smtp.purelymail.com", port: 465, secure: true },
};

const API_BASE = "https://purelymail.com/api/v0";

export class PurelymailError extends Error {
  override name = "PurelymailError";
  /** Purelymail's own explanation, safe to show (it never contains the token). */
  readonly detail: string;
  constructor(method: string, status: number, code: string, detail: string) {
    super(`${method} failed (${status}): ${code} ${detail}`.trim());
    this.detail = detail || code;
  }
}

export interface PurelymailClient {
  /** The account's ownership proof: the TXT value a domain must carry before `addDomain`. */
  getOwnershipCode(): Promise<string>;
  /** The raw `listDomains` result; `purelymailDomainState` reads it. */
  listDomains(): Promise<unknown>;
  /** Fails unless the domain passes Purelymail's DNS checks (the ownership record). */
  addDomain(domainName: string): Promise<void>;
  /** Asks Purelymail to look at the domain's DNS again now. */
  recheckDns(domainName: string): Promise<void>;
  /** Every user on the account, as full addresses (up to 1000, per the API). */
  listUsers(): Promise<string[]>;
  createUser(input: { userName: string; domainName: string; password: string }): Promise<void>;
  /** A new app password for `userHandle` (`user@domain`). Shown once; store it encrypted. */
  createAppPassword(userHandle: string, name: string): Promise<string>;
}

export function createPurelymailClient(token: string, fetchImpl = fetch): PurelymailClient {
  async function call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetchImpl(`${API_BASE}/${method}`, {
      method: "POST",
      headers: { "Purelymail-Api-Token": token, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => null)) as {
      result?: T;
      code?: string;
      message?: string;
    } | null;
    if (!response.ok || !json || json.result === undefined) {
      // The error body carries a code and a message, never the token.
      throw new PurelymailError(
        method,
        response.status,
        json?.code ?? "unknown",
        json?.message ?? "",
      );
    }
    return json.result;
  }

  return {
    async getOwnershipCode() {
      const { code } = await call<{ code?: string }>("getOwnershipCode", {});
      if (!code) throw new PurelymailError("getOwnershipCode", 200, "empty", "no code returned");
      return code;
    },
    listDomains: () => call<unknown>("listDomains", { includeShared: false }),
    async addDomain(domainName) {
      await call("addDomain", { domainName });
    },
    async recheckDns(domainName) {
      await call("updateDomainSettings", { name: domainName, recheckDns: true });
    },
    async listUsers() {
      const { users } = await call<{ users?: unknown }>("listUser", {});
      if (!Array.isArray(users)) throw new PurelymailError("listUser", 200, "shape", "no users");
      return users.filter((u): u is string => typeof u === "string").map((u) => u.toLowerCase());
    },
    async createUser({ userName, domainName, password }) {
      await call("createUser", {
        userName,
        domainName,
        password,
        // Omni signs in with an app password; the welcome mail would be the inbox's first thread.
        sendWelcomeEmail: false,
      });
    },
    async createAppPassword(userHandle, name) {
      const result = await call<{ appPassword?: string }>("createAppPassword", {
        userHandle,
        name,
      });
      if (!result.appPassword) {
        throw new PurelymailError("createAppPassword", 200, "empty", "no password returned");
      }
      return result.appPassword;
    },
  };
}

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
/** The most users `listUser` returns (per the published schema). */
const LIST_USER_LIMIT = 1000;

export class PurelymailError extends Error {
  override name = "PurelymailError";
  /** Purelymail's own explanation, safe to show (it never contains the token). */
  readonly detail: string;
  /** Purelymail's error code, such as `invalidUserName`; mostly `internalError`. */
  readonly code: string;
  constructor(method: string, status: number, code: string, detail: string) {
    super(`${method} failed (${status}): ${code} ${detail}`.trim());
    this.detail = detail || code;
    this.code = code;
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
  /**
   * Turns symbolic subaddressing on or off. Off, names like `first.last` and `support-team` can be
   * mailboxes; `name+tag@` no longer reaches `name@`.
   */
  setSymbolicSubaddressing(domainName: string, enabled: boolean): Promise<void>;
  /** Every user on the account, as full addresses (up to 1000, per the API). */
  listUsers(): Promise<string[]>;
  /** Whether `userHandle` (`user@domain`) is a user on the account, past the 1000 that list. */
  hasUser(userHandle: string): Promise<boolean>;
  createUser(input: { userName: string; domainName: string; password: string }): Promise<void>;
  /** A new app password for `userHandle` (`user@domain`). Shown once; store it encrypted. */
  createAppPassword(userHandle: string, name: string): Promise<string>;
  /** Revokes one app password of `userHandle`; it stops working for IMAP and SMTP at once. */
  deleteAppPassword(userHandle: string, appPassword: string): Promise<void>;
  /** Deletes the user and all of its mail. Irreversible. */
  deleteUser(userHandle: string): Promise<void>;
  /** The account's prepaid credit in US dollars. Purelymail stops mail when it runs out. */
  accountCredit(): Promise<number>;
}

export function createPurelymailClient(token: string, fetchImpl = fetch) {
  async function call<T>(method: string, body: unknown) {
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
      // Refusals come back as HTTP 200 with `{ type: "error", code, message }` and no `result`
      // (seen live 2026-11-13). The body never carries the token.
      throw new PurelymailError(
        method,
        response.status,
        json?.code ?? "unknown",
        json?.message ?? "",
      );
    }
    const value: T = json.result;
    return value;
  }

  async function listUsers() {
    const { users } = await call<{ users?: unknown }>("listUser", {});
    if (!Array.isArray(users)) throw new PurelymailError("listUser", 200, "shape", "no users");
    return users
      .filter((u): u is string => typeof u === "string")
      .map((u) => u.toLowerCase()) satisfies string[];
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
    async setSymbolicSubaddressing(domainName, enabled) {
      await call("updateDomainSettings", { name: domainName, symbolicSubaddressing: enabled });
    },
    listUsers,
    async hasUser(userHandle) {
      const users = await listUsers();
      if (users.includes(userHandle.toLowerCase())) return true;
      // `listUser` stops at 1000 users, so a shorter list is the whole account.
      if (users.length < LIST_USER_LIMIT) return false;
      try {
        await call("getUser", { userName: userHandle });
        return true;
      } catch (error) {
        // A missing user is `internalError` "Unknown user …" (seen live 2026-11-13).
        if (error instanceof PurelymailError && /^Unknown user\b/.test(error.detail)) return false;
        throw error;
      }
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
    async deleteAppPassword(userHandle, appPassword) {
      await call("deleteAppPassword", { userName: userHandle, appPassword });
    },
    async deleteUser(userHandle) {
      await call("deleteUser", { userName: userHandle });
    },
    async accountCredit() {
      // A decimal string with many digits (seen live 2026-11-13), not a JSON number.
      const { credit } = await call<{ credit?: unknown }>("checkAccountCredit", {});
      const dollars = Number(credit);
      if (typeof credit !== "string" || !Number.isFinite(dollars)) {
        throw new PurelymailError("checkAccountCredit", 200, "shape", "no credit returned");
      }
      return dollars;
    },
  } satisfies PurelymailClient;
}

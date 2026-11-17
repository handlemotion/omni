import type { Keyring } from "@omni/crypto";
import { type Db, replaceMailboxCredentials } from "@omni/db";
import { openCredentials, sealCredentials } from "../credentials.ts";
import type { Logger } from "../log.ts";
import type { MailHost } from "./mail-host.ts";

export const ROTATE_WINDOW_MS = 6 * 60 * 60_000;
/** A failed rotation is tried again this much later, up to `ROTATE_RETRIES` times. */
export const ROTATE_RETRY_MS = 15 * 60_000;
export const ROTATE_RETRIES = 8;

export interface HostedMailboxRow {
  id: string;
  credentialsEnc: string;
}

export function createLoginRotation(deps: {
  db: Db;
  keyring: Keyring;
  host: MailHost;
  /** The service's reconnect: replaces the mailbox's connection with one on its stored login. */
  reconnect(mailboxId: string): Promise<void>;
  logger: Logger;
  now?: () => number;
}) {
  const { db, keyring, host, logger } = deps;
  const now = deps.now ?? Date.now;
  const lastRotated = new Map<string, number>();
  const retries = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  async function rotateOnce(row: HostedMailboxRow) {
    const old = await openCredentials(keyring, row.id, row.credentialsEnc);
    if ("oauth" in old) return false;
    const next = await host.issueLogin(old.user, { createUser: false });
    const swapped = await replaceMailboxCredentials(db, {
      mailboxId: row.id,
      expected: row.credentialsEnc,
      next: await sealCredentials(keyring, row.id, next),
    });
    if (!swapped) {
      await host.revokeLogin(old.user, next.pass);
      logger.info("hosting.rotate_superseded", { mailboxId: row.id });
      return false;
    }
    lastRotated.set(row.id, now());
    logger.warn("hosting.login_rotated", { mailboxId: row.id });
    await deps.reconnect(row.id);
    await host.revokeLogin(old.user, old.pass);
    return true;
  }

  async function attempt(row: HostedMailboxRow, retriesLeft: number) {
    try {
      return await rotateOnce(row);
    } catch (error) {
      logger.warn("hosting.rotate_failed", { mailboxId: row.id, retriesLeft, error });
      if (retriesLeft > 0 && !stopped) {
        const timer = setTimeout(() => {
          retries.delete(row.id);
          void attempt(row, retriesLeft - 1);
        }, ROTATE_RETRY_MS);
        timer.unref();
        retries.set(row.id, timer);
      }
      return false;
    }
  }

  return {
    rotate(row: HostedMailboxRow) {
      if (stopped || retries.has(row.id)) return Promise.resolve(false) satisfies Promise<boolean>;
      const rotated = lastRotated.get(row.id);
      if (rotated !== undefined && now() - rotated < ROTATE_WINDOW_MS) {
        return Promise.resolve(false) satisfies Promise<boolean>;
      }
      return attempt(row, ROTATE_RETRIES) satisfies Promise<boolean>;
    },
    stop() {
      stopped = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
    },
  };
}

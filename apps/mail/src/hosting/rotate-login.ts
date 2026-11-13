// A hosted mailbox whose app password stopped working gets a new one (plan H-4). Omni operates
// the host, so it can mint a login itself instead of leaving the mailbox in `error` until someone
// notices: a password revoked by hand at Purelymail, or rotated by an admin, heals on its own.
//
// Order: issue the new login, swap it in only while the stored one is unchanged, reconnect through
// the service's own path (so any mailbox lease holds), then revoke the old one. A crash anywhere
// leaves at most one unused app password on the host, which the next rotation does not need.
// At most one new login per mailbox per window: a host that refuses every login must not get a new
// app password on every reconnect attempt. A rotation that fails (host unreachable) is retried on
// its own, because the connection stops retrying a login that keeps failing.
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

  /** True when the mailbox got a new login and was reconnected with it. */
  async function rotateOnce(row: HostedMailboxRow): Promise<boolean> {
    const old = await openCredentials(keyring, row.id, row.credentialsEnc);
    if ("oauth" in old) return false;
    // The login's own user, which may differ from the mailbox's address (`mailbox:add --user`).
    // A user deleted at the host stays deleted: only a lost password is healed.
    const next = await host.issueLogin(old.user, { createUser: false });
    const swapped = await replaceMailboxCredentials(db, {
      mailboxId: row.id,
      expected: row.credentialsEnc,
      next: await sealCredentials(keyring, row.id, next),
    });
    if (!swapped) {
      // Someone saved another login meanwhile; theirs wins and ours is never used.
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

  async function attempt(row: HostedMailboxRow, retriesLeft: number): Promise<boolean> {
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
    /** Never throws: a failure is logged and retried later. */
    rotate(row: HostedMailboxRow): Promise<boolean> {
      if (stopped || retries.has(row.id)) return Promise.resolve(false);
      const rotated = lastRotated.get(row.id);
      if (rotated !== undefined && now() - rotated < ROTATE_WINDOW_MS) {
        return Promise.resolve(false);
      }
      return attempt(row, ROTATE_RETRIES);
    },
    stop() {
      stopped = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
    },
  };
}

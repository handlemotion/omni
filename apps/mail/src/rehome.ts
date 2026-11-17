import { randomUUIDv7 } from "node:crypto";
import type { Keyring } from "@omni/crypto";
import {
  type Db,
  deleteMailbox,
  carryThreadState,
  findOrgMailbox,
  firstSyncDone,
  hasUnsyncedWork,
  listMisplacedMailboxes,
  mailboxOwnerIds,
  type MisplacedMailbox,
  saveMailbox,
} from "@omni/db";
import { openCredentials, sealCredentials } from "./credentials.ts";
import type { Logger } from "./log.ts";

export interface RehomeDeps {
  db: Db;
  keyring: Keyring;
  /** Stops a mailbox's connection and waits for work already running on it. */
  stop(mailboxId: string): Promise<void>;
  logger: Logger;
}

/** Moves every misplaced mailbox. One that cannot move is logged and left for the next run. */
export async function rehomeMailboxes(deps: RehomeDeps) {
  let moved = 0;
  for (const mailbox of await listMisplacedMailboxes(deps.db)) {
    try {
      if (await rehome(deps, mailbox)) moved += 1;
    } catch (error) {
      deps.logger.error("mailbox.rehome_failed", { mailboxId: mailbox.id, error });
    }
  }
  return moved;
}

async function rehome(deps: RehomeDeps, mailbox: MisplacedMailbox) {
  const { db, keyring, logger } = deps;
  if (await hasUnsyncedWork(db, mailbox.id)) {
    logger.info("mailbox.rehome_deferred", { mailboxId: mailbox.id, reason: "unsynced_work" });
    return false;
  }
  const existing = await findOrgMailbox(db, mailbox.targetOrgId, mailbox.address);
  if (existing) {
    const owners = await mailboxOwnerIds(db, existing.id);
    if (
      existing.kind !== "personal" ||
      existing.provider !== mailbox.provider ||
      !owners.includes(mailbox.targetMemberId)
    ) {
      logger.warn("mailbox.rehome_conflict", {
        mailboxId: mailbox.id,
        targetOrgId: mailbox.targetOrgId,
        existingId: existing.id,
      });
      return false;
    }
  }
  if (!existing) {
    const credentials = await openCredentials(keyring, mailbox.id, mailbox.credentialsEnc);
    const id = randomUUIDv7();
    await saveMailbox(db, {
      id,
      orgId: mailbox.targetOrgId,
      address: mailbox.address,
      kind: "personal",
      provider: mailbox.provider,
      credentialsEnc: await sealCredentials(keyring, id, credentials),
      ownerMemberId: mailbox.targetMemberId,
    });
    logger.info("mailbox.rehome_copying", { from: mailbox.id, to: id });
    return false;
  }
  if (!(await firstSyncDone(db, existing.id))) {
    logger.info("mailbox.rehome_deferred", { mailboxId: mailbox.id, reason: "copy_syncing" });
    return false;
  }
  const carried = await carryThreadState(db, {
    fromMailboxId: mailbox.id,
    toMailboxId: existing.id,
    toOrgId: mailbox.targetOrgId,
    toMemberId: mailbox.targetMemberId,
  });
  await deps.stop(mailbox.id);
  await deleteMailbox(db, mailbox.id);
  logger.info("mailbox.rehomed", {
    from: mailbox.id,
    to: existing.id,
    fromOrgId: mailbox.orgId,
    toOrgId: mailbox.targetOrgId,
    carried,
  });
  return true;
}

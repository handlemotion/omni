// A mailbox moves when its address finds a new home (ADR 0024 decision 2): once a company locks a
// domain, a member's mailbox on it in their Personal space becomes that company's. The move is a
// reconnect, not a row rewrite: the same login is saved in the company under a new id, and the old
// copy with everything indexed from it is deleted. The provider holds the mail, and the new copy
// syncs it again (ADR 0013). Each run converges: a move cut short is finished by the next run,
// which finds the company copy already there and reuses it.
import { randomUUIDv7 } from "node:crypto";
import type { Keyring } from "@omni/crypto";
import {
  type Db,
  deleteMailbox,
  findOrgMailbox,
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
export async function rehomeMailboxes(deps: RehomeDeps): Promise<number> {
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

async function rehome(deps: RehomeDeps, mailbox: MisplacedMailbox): Promise<boolean> {
  const { db, keyring, logger } = deps;
  // Drafts live only in Postgres, and an unsent action would be lost with the old copy: it moves
  // on a later run, once they are sent or discarded.
  if (await hasUnsyncedWork(db, mailbox.id)) {
    logger.info("mailbox.rehome_deferred", { mailboxId: mailbox.id, reason: "unsynced_work" });
    return false;
  }
  const existing = await findOrgMailbox(db, mailbox.targetOrgId, mailbox.address);
  // The company already has this address as something else (a shared inbox, another provider)
  // or as someone else's inbox: moving in would change whose it is (ADR 0017). Left where it
  // is, for a person to sort out.
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
  const credentials = await openCredentials(keyring, mailbox.id, mailbox.credentialsEnc);
  const id = existing?.id ?? randomUUIDv7();
  await saveMailbox(db, {
    id,
    orgId: mailbox.targetOrgId,
    address: mailbox.address,
    kind: "personal",
    provider: mailbox.provider,
    credentialsEnc: await sealCredentials(keyring, id, credentials),
    ownerMemberId: mailbox.targetMemberId,
  });
  await deps.stop(mailbox.id);
  await deleteMailbox(db, mailbox.id);
  logger.info("mailbox.rehomed", {
    from: mailbox.id,
    to: id,
    fromOrgId: mailbox.orgId,
    toOrgId: mailbox.targetOrgId,
  });
  return true;
}

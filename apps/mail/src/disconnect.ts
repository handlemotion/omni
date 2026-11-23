import type { GoogleDisconnectBody, HostedDisconnectBody } from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import {
  type Db,
  deleteMailbox,
  findOrgMailboxById,
  forUser,
  mailboxOwnerIds,
  setMailboxStatus,
} from "@omni/db";
import { openCredentials } from "./credentials.ts";
import type { MailHost } from "./hosting/mail-host.ts";
import type { Logger } from "./log.ts";
import { providerTraits } from "./mailbox-config.ts";
import { revokeGoogleToken } from "./providers/gmail.ts";
import { ProvisionError } from "./provisioning.ts";

type DisconnectDeps = {
  db: Db;
  keyring: Keyring;
  /** Unset on an install without a host API: nothing to revoke there. */
  host?: MailHost;
  /** Stops the mailbox's connection and waits for outbox work already running on it. */
  stop(mailboxId: string): Promise<void>;
  logger: Logger;
};

type StoredMailbox = NonNullable<Awaited<ReturnType<typeof findOrgMailboxById>>>;

/**
 * Removes any mailbox of the org from Omni, whatever its provider: stops it, revokes
 * what Omni holds (a hosted app password, a Google token; an IMAP login is only forgotten) and
 * deletes Omni's index of it. The mail stays wherever it lives. Idempotent.
 */
export const disconnectMailbox: (
  deps: DisconnectDeps,
  input: HostedDisconnectBody,
) => Promise<{ mailboxId: string }> = async (deps, input) => {
  const mailbox = await findOrgMailboxById(deps.db, input.orgId, input.mailboxId);
  if (!mailbox) return { mailboxId: input.mailboxId };
  return remove(deps, input.orgId, mailbox);
};

/**
 * Disconnects a member's Google account: Omni stops syncing it, revokes the grant at Google and
 * deletes the mailbox with everything indexed from it (Gmail still holds the mail). Only the
 * mailbox's owner can, and a mailbox already gone answers as disconnected, so a retry is safe.
 */
export const disconnectGoogle: (
  deps: DisconnectDeps,
  input: GoogleDisconnectBody,
) => Promise<{ mailboxId: string }> = async (deps, input) => {
  const { db } = deps;
  if (input.userId) {
    const owned = (await forUser(db, input.userId).googleAccounts()).find(
      (account) => account.id === input.mailboxId,
    );
    if (!owned) return { mailboxId: input.mailboxId };
    input = { ...input, orgId: owned.orgId, memberId: owned.memberId };
  }
  const mailbox = await findOrgMailboxById(db, input.orgId, input.mailboxId);
  if (!mailbox) return { mailboxId: input.mailboxId };
  const owners = await mailboxOwnerIds(db, mailbox.id);
  if (
    mailbox.provider !== "gmail" ||
    mailbox.kind !== "personal" ||
    !owners.includes(input.memberId)
  ) {
    throw new ProvisionError(404, "No such Google account");
  }
  return remove(deps, input.orgId, mailbox);
};

async function remove(deps: DisconnectDeps, orgId: string, mailbox: StoredMailbox) {
  const { db, logger } = deps;
  await setMailboxStatus(db, mailbox.id, "disabled");
  await deps.stop(mailbox.id);
  try {
    const login = await openCredentials(deps.keyring, mailbox.id, mailbox.credentialsEnc);
    if ("oauth" in login) await revokeGoogleToken(login.refreshToken);
    else if (providerTraits(mailbox.provider).hostedLogin)
      await deps.host?.revokeLogin(login.user, login.pass);
  } catch (error) {
    logger.warn("mailbox.disconnect_revoke_failed", { mailboxId: mailbox.id, error });
  }
  await deleteMailbox(db, mailbox.id);
  logger.info("mailbox.disconnected", { orgId, mailboxId: mailbox.id, provider: mailbox.provider });
  return { mailboxId: mailbox.id };
}

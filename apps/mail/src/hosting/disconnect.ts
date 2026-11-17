import type { HostedDisconnectBody } from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, deleteMailbox, findOrgMailboxById, setMailboxStatus } from "@omni/db";
import { openCredentials } from "../credentials.ts";
import type { Logger } from "../log.ts";
import { revokeGoogleToken } from "../providers/gmail.ts";
import { ProvisionError } from "../provisioning.ts";
import type { MailHost } from "./mail-host.ts";

type DisconnectDeps = {
  db: Db;
  keyring: Keyring;
  /** Unset on an install without a host API: nothing to revoke there. */
  host?: MailHost;
  /** Stops the mailbox's connection and waits for outbox work already running on it. */
  stop(mailboxId: string): Promise<void>;
  logger: Logger;
};

/** Removes an Omni-hosted mailbox only; any other kind answers 404. */
export const disconnectHostedMailbox: (
  deps: DisconnectDeps,
  input: HostedDisconnectBody,
) => Promise<{ mailboxId: string }> = async (deps, input) => {
  const mailbox = await findOrgMailboxById(deps.db, input.orgId, input.mailboxId);
  if (!mailbox) return { mailboxId: input.mailboxId };
  if (mailbox.provider !== "purelymail") throw new ProvisionError(404, "No such hosted mailbox");
  return disconnectMailbox(deps, input);
};

/**
 * Removes any mailbox of the org from Omni (ADR 0026), whatever its provider: stops it, revokes
 * what Omni holds (a hosted app password, a Google token; an IMAP login is only forgotten) and
 * deletes Omni's index of it. The mail stays wherever it lives. Idempotent.
 */
export const disconnectMailbox: (
  deps: DisconnectDeps,
  input: HostedDisconnectBody,
) => Promise<{ mailboxId: string }> = async (deps, input) => {
  const { db, logger } = deps;
  const mailbox = await findOrgMailboxById(db, input.orgId, input.mailboxId);
  if (!mailbox) return { mailboxId: input.mailboxId };

  await setMailboxStatus(db, mailbox.id, "disabled");
  await deps.stop(mailbox.id);
  try {
    const login = await openCredentials(deps.keyring, mailbox.id, mailbox.credentialsEnc);
    if ("oauth" in login) await revokeGoogleToken(login.refreshToken);
    else if (mailbox.provider === "purelymail")
      await deps.host?.revokeLogin(login.user, login.pass);
  } catch (error) {
    logger.warn("mailbox.disconnect_revoke_failed", { mailboxId: mailbox.id, error });
  }
  await deleteMailbox(db, mailbox.id);
  logger.info("mailbox.disconnected", {
    orgId: input.orgId,
    mailboxId: mailbox.id,
    provider: mailbox.provider,
  });
  return { mailboxId: mailbox.id };
};

// Removing an Omni-hosted mailbox from Omni (decided 2026-11-13: disconnect, keep the mail). Omni
// stops syncing, revokes the app password it holds and forgets the mailbox. The user at the host
// and every message stay: Postgres is only an index, and adding the address again reconnects it
// with a new app password. Deleting the host's user is never done here.
import type { HostedDisconnectBody } from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, deleteMailbox, findOrgMailboxById, setMailboxStatus } from "@omni/db";
import { openCredentials } from "../credentials.ts";
import type { Logger } from "../log.ts";
import { ProvisionError } from "../provisioning.ts";
import type { MailHost } from "./mail-host.ts";

export async function disconnectHostedMailbox(
  deps: {
    db: Db;
    keyring: Keyring;
    /** Unset on an install without a host API: nothing to revoke there. */
    host?: MailHost;
    /** Stops the mailbox's connection and waits for outbox work already running on it. */
    stop(mailboxId: string): Promise<void>;
    logger: Logger;
  },
  input: HostedDisconnectBody,
): Promise<{ mailboxId: string }> {
  const { db, logger } = deps;
  const mailbox = await findOrgMailboxById(db, input.orgId, input.mailboxId);
  if (!mailbox) return { mailboxId: input.mailboxId };
  if (mailbox.provider !== "purelymail") throw new ProvisionError(404, "No such hosted mailbox");

  // Disabled first, so a reconcile running now does not connect it again.
  await setMailboxStatus(db, mailbox.id, "disabled");
  await deps.stop(mailbox.id);
  try {
    const login = await openCredentials(deps.keyring, mailbox.id, mailbox.credentialsEnc);
    if (!("oauth" in login)) await deps.host?.revokeLogin(login.user, login.pass);
  } catch (error) {
    // Forgetting the only copy is what matters; an app password the host kept is unused and
    // shows in the host's dashboard, where it can be removed by hand.
    logger.warn("hosting.disconnect_revoke_failed", { mailboxId: mailbox.id, error });
  }
  await deleteMailbox(db, mailbox.id);
  logger.info("hosting.mailbox_disconnected", { orgId: input.orgId, mailboxId: mailbox.id });
  return { mailboxId: mailbox.id };
}

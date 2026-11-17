// Onboarding's provider work (ADR 0007): add a domain at the mail host and read back its DNS
// checks, and create a mailbox (a login issued by the host, or an existing IMAP login), store it
// encrypted and start syncing it. The Worker decides who may ask; `planMailboxProvision` re-checks
// the domain claim before anything touches the host. Host specifics live in `hosting/`.
//
// Idempotent on natural keys: the domain name, and (org, address) for a mailbox. Running a call
// twice adds nothing at the provider the first run already added.
import { randomUUIDv7 } from "node:crypto";
import type {
  ProvisionDomainResult,
  ProvisionMailboxBody,
  ProvisionMailboxResult,
} from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, findOrgDomain, findOrgMailbox, saveMailbox } from "@omni/db";
import { planMailboxProvision } from "@omni/mail-core/mailbox-provisioning";
import { type PasswordCredentials, openCredentials, sealCredentials } from "./credentials.ts";
import { type MailHost, MailHostError } from "./hosting/mail-host.ts";
import type { Logger } from "./log.ts";
import { verifyImapLogin } from "./verify-login.ts";

/** A refusal the Worker passes on to the member, with the status to use. */
export class ProvisionError extends Error {
  override name = "ProvisionError";
  readonly status: 400 | 404 | 409 | 422 | 502;
  constructor(status: 400 | 404 | 409 | 422 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Provisioner {
  /** With `add: false`, reads the records and their state without touching the provider. */
  domain(domain: string, options?: { add?: boolean }): Promise<ProvisionDomainResult>;
  mailbox(input: ProvisionMailboxBody): Promise<ProvisionMailboxResult>;
}

export function createProvisioner(deps: {
  db: Db;
  keyring: Keyring;
  /** Absent without a host API (PURELYMAIL_API_TOKEN): only existing IMAP logins can be added. */
  host?: MailHost;
  /** Connect the mailbox with its stored credentials, replacing a connection it already has. */
  connect(mailboxId: string): Promise<void>;
  logger: Logger;
}) {
  const { db, keyring, logger } = deps;
  const { host } = deps;
  // One provisioning run per address at a time, so a double submit cannot create two app
  // passwords. This service runs as one machine (ADR 0004); the natural keys cover the rest.
  const running = new Map<string, Promise<ProvisionMailboxResult>>();

  /** The host's answer; a bad request becomes a 422, a host failure or outage a 502. */
  async function hosted<T>(task: () => Promise<T>) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof MailHostError) throw new ProvisionError(error.status, error.message);
      throw error;
    }
  }

  const domain: (
    name: string,
    options?: { add?: boolean },
  ) => Promise<ProvisionDomainResult> = async (name, options = {}) => {
    if (!host) return { provider: "imap" };
    const state = await hosted(() => host.domain(name, { add: options.add !== false }));
    return { provider: host.provider, ...state };
  };

  const createMailbox: (input: ProvisionMailboxBody) => Promise<ProvisionMailboxResult> = async (
    input,
  ) => {
    const { orgId, address } = input;
    const domainName = address.slice(address.lastIndexOf("@") + 1);
    const existing = await findOrgMailbox(db, orgId, address);
    const plan = planMailboxProvision({
      domain: domainName,
      provider: input.login.provider,
      claim: await findOrgDomain(db, orgId, domainName),
      hostConfigured: host !== undefined,
      existing,
    });
    if (plan.kind === "refuse") throw new ProvisionError(409, plan.message);
    if (plan.kind === "reuse") return { mailboxId: plan.mailboxId, address, created: false };

    let credentials: PasswordCredentials;
    if (input.login.provider === "purelymail") {
      // The plan refuses a hosted mailbox when no host is configured.
      if (!host) throw new ProvisionError(409, "Purelymail is not configured here");
      credentials = await hosted(() => host.issueLogin(address));
      logger.info("provision.login_issued", { orgId, address });
    } else {
      const { user, pass, imap, smtp } = input.login;
      credentials = { user, pass, imap, smtp };
      if (existing && plan.sameLoginCheck && (await sameLogin(existing, credentials))) {
        return { mailboxId: existing.id, address, created: false };
      }
      const refused = await verifyImapLogin(credentials);
      if (refused) throw new ProvisionError(422, refused);
    }
    const mailboxId = plan.mailboxId ?? randomUUIDv7();

    await saveMailbox(db, {
      id: mailboxId,
      orgId,
      address,
      kind: input.kind,
      provider: input.login.provider,
      // Bound to the mailbox id: copied to another row, it fails to decrypt.
      credentialsEnc: await sealCredentials(keyring, mailboxId, credentials),
      ownerMemberId: input.ownerMemberId,
    });
    logger.info("provision.mailbox_saved", { orgId, mailboxId, provider: input.login.provider });
    // Connects it now (a new login replaces the old connection); the first sync imports its
    // history in the background.
    void deps
      .connect(mailboxId)
      .catch((error: unknown) => logger.error("mailbox.connect_failed", { mailboxId, error }));
    return { mailboxId, address, created: true };
  };

  /** The stored login is this one already: nothing to save or reconnect. */
  async function sameLogin(
    existing: { id: string; credentialsEnc: string },
    next: PasswordCredentials,
  ) {
    try {
      const stored = await openCredentials(keyring, existing.id, existing.credentialsEnc);
      return JSON.stringify(stored) === JSON.stringify(next);
    } catch {
      return false;
    }
  }

  return {
    domain,
    mailbox(input) {
      const key = `${input.orgId}\n${input.address}`;
      const pending = running.get(key);
      if (pending) return pending;
      const run = createMailbox(input).finally(() => running.delete(key));
      running.set(key, run);
      return run;
    },
  } satisfies Provisioner;
}

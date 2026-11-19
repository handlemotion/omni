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
import { checkMailHost, type MailHostPolicy, withPlaintextPolicy } from "./mail-hosts.ts";
import { verifyImapLogin } from "./verify-login.ts";

const notPublic = (host: string) => `${host} isn't a public mail server Omni can connect to`;

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
  /** Which hosts a member's own IMAP/SMTP login may use: see `MailHostPolicy`. */
  hosts: MailHostPolicy;
  logger: Logger;
}) {
  const { db, keyring, logger } = deps;
  const { host } = deps;
  const running = new Map<string, Promise<ProvisionMailboxResult>>();

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
      if (!host) throw new ProvisionError(409, "Purelymail is not configured here");
      credentials = await hosted(() => host.issueLogin(address));
      logger.info("provision.login_issued", { orgId, address });
    } else {
      const { user, pass, imap, smtp } = input.login;
      credentials = { user, pass, imap, smtp };
      if (existing && plan.sameLoginCheck && (await sameLogin(existing, credentials))) {
        return { mailboxId: existing.id, address, created: false };
      }
      const refused = await verifyMemberLogin(credentials);
      if (refused) throw new ProvisionError(422, refused);
    }
    const mailboxId = plan.mailboxId ?? randomUUIDv7();

    await saveMailbox(db, {
      id: mailboxId,
      orgId,
      address,
      kind: input.kind,
      provider: input.login.provider,
      credentialsEnc: await sealCredentials(keyring, mailboxId, credentials),
      ownerMemberId: input.ownerMemberId,
    });
    logger.info("provision.mailbox_saved", { orgId, mailboxId, provider: input.login.provider });
    void deps
      .connect(mailboxId)
      .catch((error: unknown) => logger.error("mailbox.connect_failed", { mailboxId, error }));
    return { mailboxId, address, created: true };
  };

  async function verifyMemberLogin(credentials: PasswordCredentials) {
    const [imap, smtp] = await Promise.all([
      checkMailHost(credentials.imap.host, deps.hosts),
      checkMailHost(credentials.smtp.host, deps.hosts),
    ]);
    if (!imap.ok) return notPublic(credentials.imap.host);
    if (!smtp.ok) return notPublic(credentials.smtp.host);
    return verifyImapLogin(
      { ...credentials, imap: withPlaintextPolicy(credentials.imap, deps.hosts) },
      imap.addresses,
    );
  }

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

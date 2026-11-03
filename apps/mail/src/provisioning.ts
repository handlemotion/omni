// Onboarding's provider work (ADR 0007): add a domain at the provider and read back its DNS
// checks, and create a mailbox (a Purelymail user plus an app password, or an existing IMAP
// login), store it encrypted and start syncing it. The Worker decides who may ask; this module
// re-checks the domain claim before it touches the provider.
//
// Idempotent on natural keys: the domain name, and (org, address) for a mailbox. Running a call
// twice adds nothing at the provider the first run already added.
import { randomBytes, randomUUIDv7 } from "node:crypto";
import type {
  ProvisionDomainResult,
  ProvisionMailboxBody,
  ProvisionMailboxResult,
} from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, findOrgDomain, findOrgMailbox, saveMailbox } from "@omni/db";
import { purelymailDnsRecords, purelymailDomainState, withChecks } from "@omni/mail-core/domains";
import { type MailboxCredentials, openCredentials, sealCredentials } from "./credentials.ts";
import type { Logger } from "./log.ts";
import {
  type PurelymailClient,
  PurelymailError,
  PURELYMAIL_SERVERS,
} from "./providers/purelymail.ts";
import { verifyImapLogin } from "./verify-login.ts";

/** A refusal the Worker passes on to the member, with the status to use. */
export class ProvisionError extends Error {
  override name = "ProvisionError";
  readonly status: 400 | 409 | 422 | 502;
  constructor(status: 400 | 409 | 422 | 502, message: string) {
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
  /** Absent without PURELYMAIL_API_TOKEN: only existing IMAP logins can be added. */
  purelymail?: PurelymailClient;
  /** Connect the mailbox with its stored credentials, replacing a connection it already has. */
  connect(mailboxId: string): Promise<void>;
  logger: Logger;
}): Provisioner {
  const { db, keyring, purelymail, logger } = deps;
  // One provisioning run per address at a time, so a double submit cannot create two app
  // passwords. This service runs as one machine (ADR 0004); the natural keys cover the rest.
  const running = new Map<string, Promise<ProvisionMailboxResult>>();

  /** Purelymail's answer, or a 502 that says which call failed and why. */
  async function provider<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      logger.warn("provision.purelymail_failed", { error });
      throw new ProvisionError(
        502,
        error instanceof PurelymailError
          ? `Purelymail: ${error.detail}`
          : "Purelymail is unreachable",
      );
    }
  }

  async function domain(
    name: string,
    options: { add?: boolean } = {},
  ): Promise<ProvisionDomainResult> {
    if (!purelymail) return { provider: "imap" };
    const records = purelymailDnsRecords(name, await provider(() => purelymail.getOwnershipCode()));
    let state = purelymailDomainState(await provider(() => purelymail.listDomains()), name);
    if (options.add === false) {
      return {
        provider: "purelymail",
        added: state.added,
        records: withChecks(records, state.checks),
      };
    }
    let addError: string | undefined;
    if (!state.added) {
      // Purelymail adds a domain only once its ownership record is in DNS. Until then this fails,
      // and the member sees the records to add and Purelymail's reason.
      try {
        await purelymail.addDomain(name);
        logger.info("provision.domain_added", { domain: name });
      } catch (error) {
        if (!(error instanceof PurelymailError))
          throw new ProvisionError(502, "Purelymail is unreachable");
        addError = error.detail;
      }
    } else {
      await provider(() => purelymail.recheckDns(name));
    }
    if (addError === undefined) {
      state = purelymailDomainState(await provider(() => purelymail.listDomains()), name);
    }
    return {
      provider: "purelymail",
      added: state.added,
      records: withChecks(records, state.checks),
      ...(addError !== undefined ? { addError } : {}),
    };
  }

  async function createMailbox(input: ProvisionMailboxBody): Promise<ProvisionMailboxResult> {
    const { orgId, address } = input;
    const domainName = address.slice(address.lastIndexOf("@") + 1);
    const claim = await findOrgDomain(db, orgId, domainName);
    if (!claim) throw new ProvisionError(409, `${domainName} is not set up for this workspace`);
    if (claim.provider !== input.login.provider) {
      throw new ProvisionError(409, `${domainName} is set up for ${claim.provider}`);
    }

    let credentials: MailboxCredentials;
    let mailboxId: string;
    if (input.login.provider === "purelymail") {
      if (!purelymail) throw new ProvisionError(409, "Purelymail is not configured here");
      if (!claim.addedAt) {
        throw new ProvisionError(
          409,
          `${domainName} is not on Purelymail yet: add its ownership record`,
        );
      }
      const existing = await findOrgMailbox(db, orgId, address);
      // Already provisioned: a second app password would only be one more secret to revoke.
      if (existing?.provider === "purelymail") {
        return { mailboxId: existing.id, address, created: false };
      }
      const users = await provider(() => purelymail.listUsers());
      if (!users.includes(address)) {
        // Omni never knows or keeps a mailbox's real password: this one is thrown away, and the
        // person sets their own through Purelymail when they want Apple Mail as a fallback.
        await provider(() =>
          purelymail.createUser({
            userName: address.slice(0, address.lastIndexOf("@")),
            domainName,
            password: randomBytes(32).toString("base64url"),
          }),
        );
        logger.info("provision.user_created", { orgId, address });
      }
      const pass = await provider(() => purelymail.createAppPassword(address, "Omni"));
      credentials = { user: address, pass, ...PURELYMAIL_SERVERS };
      mailboxId = existing?.id ?? randomUUIDv7();
    } else {
      const { user, pass, imap, smtp } = input.login;
      credentials = { user, pass, imap, smtp };
      const existing = await findOrgMailbox(db, orgId, address);
      if (existing?.provider === "imap" && (await sameLogin(existing, credentials))) {
        return { mailboxId: existing.id, address, created: false };
      }
      const refused = await verifyImapLogin(credentials);
      if (refused) throw new ProvisionError(422, refused);
      mailboxId = existing?.id ?? randomUUIDv7();
    }

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
  }

  /** The stored login is this one already: nothing to save or reconnect. */
  async function sameLogin(
    existing: { id: string; credentialsEnc: string },
    next: MailboxCredentials,
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
  };
}

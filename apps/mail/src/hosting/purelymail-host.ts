// Purelymail as a MailHost (ADR 0007): domains on the account, a user per mailbox, an app password
// per login. Checks `listDomains` and `listUser` before adding, because Purelymail does not document
// its error codes.
import { randomBytes } from "node:crypto";
import { purelymailDnsRecords, purelymailDomainState, withChecks } from "@omni/mail-core/domains";
import type { Logger } from "../log.ts";
import {
  type PurelymailClient,
  PurelymailError,
  PURELYMAIL_SERVERS,
} from "../providers/purelymail.ts";
import { type HostedDomain, type MailHost, MailHostError } from "./mail-host.ts";

export function createPurelymailHost(client: PurelymailClient, logger: Logger): MailHost {
  /** Purelymail's answer, or a MailHostError that says why it failed. */
  async function call<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      logger.warn("provision.purelymail_failed", { error });
      throw new MailHostError(
        error instanceof PurelymailError
          ? `Purelymail: ${error.detail}`
          : "Purelymail is unreachable",
      );
    }
  }

  async function domain(name: string, options: { add: boolean }): Promise<HostedDomain> {
    const records = purelymailDnsRecords(name, await call(() => client.getOwnershipCode()));
    let state = purelymailDomainState(await call(() => client.listDomains()), name);
    if (!options.add) return { added: state.added, records: withChecks(records, state.checks) };

    let addError: string | undefined;
    if (!state.added) {
      // Purelymail adds a domain only once its ownership record is in DNS. Until then this fails,
      // and the member sees the records to add and Purelymail's reason.
      try {
        await client.addDomain(name);
        logger.info("provision.domain_added", { domain: name });
      } catch (error) {
        if (!(error instanceof PurelymailError)) {
          throw new MailHostError("Purelymail is unreachable");
        }
        addError = error.detail;
      }
    } else {
      await call(() => client.recheckDns(name));
    }
    if (addError === undefined) {
      state = purelymailDomainState(await call(() => client.listDomains()), name);
    }
    return {
      added: state.added,
      records: withChecks(records, state.checks),
      ...(addError !== undefined ? { addError } : {}),
    };
  }

  async function issueLogin(address: string) {
    const at = address.lastIndexOf("@");
    const users = await call(() => client.listUsers());
    if (!users.includes(address)) {
      // Omni never knows or keeps a mailbox's real password: this one is thrown away, and the
      // person sets their own through Purelymail when they want Apple Mail as a fallback.
      await call(() =>
        client.createUser({
          userName: address.slice(0, at),
          domainName: address.slice(at + 1),
          password: randomBytes(32).toString("base64url"),
        }),
      );
      logger.info("provision.user_created", { address });
    }
    const pass = await call(() => client.createAppPassword(address, "Omni"));
    return { user: address, pass, ...PURELYMAIL_SERVERS };
  }

  return { provider: "purelymail", domain, issueLogin };
}

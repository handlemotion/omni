import { randomBytes } from "node:crypto";
import {
  purelymailDnsRecords,
  purelymailDomainState,
  purelymailUsernameProblem,
  withChecks,
} from "@omni/mail-core/domains";
import type { Logger } from "../log.ts";
import {
  type PurelymailClient,
  PurelymailError,
  PURELYMAIL_SERVERS,
} from "../providers/purelymail.ts";
import { type HostedDomain, type MailHost, MailHostError } from "./mail-host.ts";

export function createPurelymailHost(client: PurelymailClient, logger: Logger) {
  async function call<T>(task: () => Promise<T>) {
    try {
      return await task();
    } catch (error) {
      logger.warn("provision.purelymail_failed", { error });
      if (!(error instanceof PurelymailError)) throw new MailHostError("Purelymail is unreachable");
      throw new MailHostError(
        `Purelymail: ${error.detail}`,
        error.code === "invalidUserName" ? 422 : 502,
      );
    }
  }

  async function domain(name: string, options: { add: boolean }) {
    const records = purelymailDnsRecords(name, await call(() => client.getOwnershipCode()));
    let state = purelymailDomainState(await call(() => client.listDomains()), name);
    if (!options.add)
      return {
        added: state.added,
        records: withChecks(records, state.checks),
      } satisfies HostedDomain;

    let addError: string | undefined;
    if (!state.added) {
      try {
        await client.addDomain(name);
        logger.info("provision.domain_added", { domain: name });
        await call(() => client.setSymbolicSubaddressing(name, false));
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
    } satisfies HostedDomain;
  }

  async function issueLogin(address: string, options: { createUser?: boolean } = {}) {
    const at = address.lastIndexOf("@");
    if (!(await call(() => client.hasUser(address)))) {
      if (options.createUser === false) {
        throw new MailHostError(`${address} is no longer on Purelymail`);
      }
      const domainName = address.slice(at + 1);
      const state = purelymailDomainState(await call(() => client.listDomains()), domainName);
      const problem = purelymailUsernameProblem(address, state.symbolicSubaddressing);
      if (problem) throw new MailHostError(problem, 422);
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

  async function revokeLogin(address: string, pass: string) {
    try {
      await client.deleteAppPassword(address, pass);
    } catch (error) {
      if (error instanceof PurelymailError) {
        logger.info("hosting.revoke_refused", { address, detail: error.detail });
        return;
      }
      throw new MailHostError("Purelymail is unreachable");
    }
  }

  return {
    provider: "purelymail",
    domain,
    issueLogin,
    revokeLogin,
    credit: () => call(() => client.accountCredit()),
  } satisfies MailHost;
}

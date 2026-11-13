// A mail host Omni operates: the control plane for hosted mailboxes (domains, users, logins).
// Hosted mail syncs over the same IMAP/SMTP engine as any mailbox; only creating and managing the
// account at the host differs. Gmail and other bring-your-own providers never implement this.
// Purelymail is the one implementation today (`purelymail-host.ts`); a self-hoster without a host
// API runs without one and adds existing IMAP logins only.
import type { DnsRecordStatus } from "@omni/mail-core/domains";
import type { PasswordCredentials } from "../credentials.ts";

export interface HostedDomain {
  /** The host accepted the domain: mailboxes can be created on it. */
  added: boolean;
  /** The records the host asks for, each with its last check. */
  records: DnsRecordStatus[];
  /** Why the host would not add it yet, in its words (usually: no ownership record). */
  addError?: string;
}

export interface MailHost {
  readonly provider: "purelymail";
  /**
   * The domain's records and state at the host. With `add`, first asks the host to add the domain
   * (or to check its DNS again when it already has it). Safe to repeat.
   */
  domain(name: string, options: { add: boolean }): Promise<HostedDomain>;
  /**
   * A login for `address`, creating the mailbox at the host when it has none. Each call issues a
   * new app password: call it only when no login for the address is stored.
   */
  issueLogin(address: string): Promise<PasswordCredentials>;
}

/**
 * The host refused or could not be reached. `message` is safe to show the member. `status` 422:
 * the request itself is wrong (fix the input); 502: the host failed or is unreachable.
 */
export class MailHostError extends Error {
  override name = "MailHostError";
  readonly status: 422 | 502;
  constructor(message: string, status: 422 | 502 = 502) {
    super(message);
    this.status = status;
  }
}

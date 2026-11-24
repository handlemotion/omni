import type { schema } from "@omni/db";

export interface ServerEndpoint {
  host: string;
  port: number;
  /** Implicit TLS (993 / 465). False means plain, and the connection must upgrade with STARTTLS. */
  secure: boolean;
  /**
   * A `secure: false` endpoint may stay cleartext when STARTTLS isn't offered. Never stored: the
   * service decides it on load from `MAIL_ALLOW_PLAINTEXT_HOSTS` (see `withPlaintextPolicy`).
   */
  allowPlaintext?: boolean;
}

/** Mints OAuth2 access tokens for one mailbox (XOAUTH2). */
export interface TokenSource {
  /** A token valid for at least the next few minutes. */
  get(): Promise<string>;
  /** The server refused the last token: the next `get` mints a new one. */
  invalidate(): void;
  /** `get` failed because the grant is gone: retrying cannot help, the person must reconnect. */
  isRevoked(error: unknown): boolean;
}

/** How a mailbox logs in to IMAP and SMTP. */
export type MailAuth = { kind: "password"; pass: string } | { kind: "oauth2"; token: TokenSource };

/** Who hosts a mailbox, as stored on its row. */
export type MailProvider = (typeof schema.mailboxes.$inferSelect)["provider"];

/**
 * The product rules that differ by provider, in one place. These follow the stored provider (what
 * Wok promised the person); what the IMAP server can do is a separate signal, `Capabilities`
 * (`X-GM-EXT-1` for Gmail's extension), and a branch picks one or the other on purpose.
 */
export interface ProviderTraits {
  /**
   * Gmail's read is Wok's Done: a read or unread change reaches the server only with Done, and
   * the inbox is reconciled with stored flags after its first sync (mail read before Wok).
   */
  readIsDone: boolean;
  /** Imports only the last `GMAIL_SYNC_DAYS` of mail rather than the whole history. */
  syncWindow: boolean;
  /** Wok holds the host account: a rejected login mints a new app password, disconnect revokes it. */
  hostedLogin: boolean;
  /** A Google account, whose grant also reads its Google Calendar. */
  googleAccount: boolean;
}

export function providerTraits(provider: MailProvider | undefined) {
  const gmail = provider === "gmail";
  return {
    readIsDone: gmail,
    syncWindow: gmail,
    hostedLogin: provider === "purelymail",
    googleAccount: gmail,
  } satisfies ProviderTraits;
}

/** A mailbox with its decrypted login. Lives only inside the mail service. */
export interface MailboxConfig {
  id: string;
  orgId: string;
  address: string;
  /** Shared mailboxes keep read state per person in Postgres; we never touch their `\Seen`. */
  kind: "personal" | "shared";
  /** `gmail` for a Google account, where Gmail's read is Wok's Done. */
  provider?: MailProvider;
  /**
   * Index only mail from this date on. Each folder syncs from its oldest message dated
   * on or after it; everything older stays on the server. Unset: every message.
   */
  syncSince?: Date;
  user: string;
  auth: MailAuth;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

/** ImapFlow's and Nodemailer's `auth` for this mailbox, with a fresh token for OAuth2. */
export const loginFor: (
  mailbox: Pick<MailboxConfig, "user" | "auth">,
) => Promise<{ user: string; pass: string } | { user: string; accessToken: string }> = async (
  mailbox,
) => {
  return mailbox.auth.kind === "password"
    ? { user: mailbox.user, pass: mailbox.auth.pass }
    : { user: mailbox.user, accessToken: await mailbox.auth.token.get() };
};

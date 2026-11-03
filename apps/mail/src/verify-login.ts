import { ImapFlow } from "imapflow";
import type { MailboxCredentials } from "./credentials.ts";

/**
 * Logs in over IMAP and out again. Resolves to null on success, or the server's reason. Never
 * includes the password.
 */
export async function verifyImapLogin(credentials: MailboxCredentials): Promise<string | null> {
  const client = new ImapFlow({
    host: credentials.imap.host,
    port: credentials.imap.port,
    secure: credentials.imap.secure,
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  // A failed login also emits `error`; without a listener it would crash the process.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.logout();
    return null;
  } catch (error) {
    client.close();
    const reason = (error as { responseText?: string }).responseText ?? (error as Error).message;
    return `IMAP login to ${credentials.imap.host} failed: ${reason}`;
  }
}

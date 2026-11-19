import { ImapFlow } from "imapflow";
import type { PasswordCredentials } from "./credentials.ts";
import { imapTls } from "./mail-hosts.ts";

/**
 * Logs in over IMAP and out again. Resolves to null on success, or a reason to show. Only the
 * server's own IMAP reply is passed on: a network error says only that the host was unreachable,
 * so the reason can't be used to read what answers on an address. Never includes the password.
 *
 * `connectTo` are the addresses `checkMailHost` approved, tried in order while one is
 * unreachable; the host name still names the server for TLS, so a second DNS answer can't
 * redirect the login.
 */
export async function verifyImapLogin(
  credentials: PasswordCredentials,
  connectTo: readonly string[] = [credentials.imap.host],
) {
  const { imap } = credentials;
  for (const address of connectTo) {
    const failure = await tryLogin(credentials, address);
    if (failure === null) return null;
    const { responseText, tlsFailed } = failure;
    if (tlsFailed) {
      return `${imap.host} doesn't offer an encrypted connection (STARTTLS) on port ${imap.port}`;
    }
    if (responseText) return `IMAP login to ${imap.host} failed: ${responseText}`;
  }
  return `Couldn't reach an IMAP server at ${imap.host}:${imap.port}`;
}

async function tryLogin(credentials: PasswordCredentials, address: string) {
  const { imap } = credentials;
  const client = new ImapFlow({
    host: address,
    ...(address === imap.host ? {} : { servername: imap.host }),
    port: imap.port,
    ...imapTls(imap),
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.logout();
    return null;
  } catch (error) {
    client.close();
    return error as { responseText?: string; tlsFailed?: boolean };
  }
}

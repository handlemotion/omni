import { describe, expect, it } from "vitest";
import { withPlaintextPolicy } from "../src/mail-hosts.ts";
import { verifyImapLogin } from "../src/verify-login.ts";
import { GREENMAIL_PASSWORD, mailbox } from "./support/greenmail.ts";

describe("IMAP login against a server without STARTTLS", () => {
  const box = mailbox();
  const credentials = (imap: typeof box.imap) => ({
    user: box.user,
    pass: GREENMAIL_PASSWORD,
    imap,
    smtp: box.smtp,
  });
  const cleartext = { host: box.imap.host, port: box.imap.port, secure: false };

  it("refuses to send the password unless the host may stay cleartext", async () => {
    expect(await verifyImapLogin(credentials(cleartext))).toBe(
      `${cleartext.host} doesn't offer an encrypted connection (STARTTLS) on port ${cleartext.port}`,
    );
  });

  it("logs in on loopback, which never crosses a network", async () => {
    const policy = { plaintextHosts: new Set<string>() };
    expect(await verifyImapLogin(credentials(withPlaintextPolicy(cleartext, policy)))).toBeNull();
  });
});

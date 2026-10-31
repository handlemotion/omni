// Helpers for the local GreenMail from `pnpm stack:up`. Auth is disabled there: any user logs in.
import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { createLogger } from "../../src/log.ts";
import type { MailboxConfig } from "../../src/mailbox-connection.ts";

const host = process.env.GREENMAIL_HOST ?? "localhost";
const imapPort = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143);
const smtpPort = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025);
const apiPort = Number(process.env.GREENMAIL_API_PORT ?? 8080);

export const logger = createLogger(process.env.E2E_LOG_LEVEL === "debug" ? "debug" : "error");

/** Deletes every message on the server. */
export async function purge(): Promise<void> {
  const response = await fetch(`http://${host}:${apiPort}/api/mail/purge`, { method: "POST" });
  if (!response.ok) throw new Error(`GreenMail purge failed: ${response.status}`);
}

/** A fresh address per test, so folders and UIDs never leak between tests. */
export function mailbox(kind: MailboxConfig["kind"] = "personal"): MailboxConfig {
  const address = `t-${randomUUID().slice(0, 8)}@omni.test`;
  return {
    id: randomUUID(),
    orgId: "org-e2e",
    address,
    kind,
    user: address,
    pass: "unused",
    imap: { host, port: imapPort, secure: false },
    smtp: { host, port: smtpPort, secure: false },
  };
}

/** Delivers a message over SMTP, as an outside sender would. */
export async function deliver(to: string, subject: string): Promise<void> {
  const transport = createTransport({ host, port: smtpPort, secure: false });
  try {
    await transport.sendMail({
      from: "sender@outside.test",
      to,
      subject,
      text: `body of ${subject}`,
    });
  } finally {
    transport.close();
  }
}

/** A second IMAP client, standing in for Apple Mail. */
export async function otherClient<T>(
  box: MailboxConfig,
  task: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host,
    port: imapPort,
    secure: false,
    auth: { user: box.user, pass: box.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.logout();
  }
}

/** Polls until `check` returns a value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

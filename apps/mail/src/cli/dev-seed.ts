// Seeds the local stack with a workspace you can use: `pnpm --filter @omni/mail dev:seed`.
// Local only: it points mailboxes at GreenMail (`pnpm stack:up`), which takes any password.
// Creates the "Omni Dev" company owned by dev@example.com with an active subscription, a personal
// inbox (dev@example.com) and a shared one (support@example.com), and fills each GreenMail INBOX
// from fixtures/eml/ the first time. Safe to run again: the company, member, subscription and
// mailboxes are reused, and mail is appended only to an empty INBOX. Sign in afterwards with a
// magic link to dev@example.com.
import { randomUUIDv7 } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAIL_PING_PATH } from "@omni/contracts";
import { parseKeyring, signRequest } from "@omni/crypto";
import { createDb, createOrgWithOwner, findMailboxByAddress, saveMailbox } from "@omni/db";
import { subscriptions } from "@omni/db/schema";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { type PasswordCredentials, sealCredentials } from "../credentials.ts";

const OWNER = "dev@example.com";
const fixtures = join(import.meta.dirname, "../../../../fixtures/eml");
// Helpdesk-style mail goes to the shared inbox; everything else to the owner's own.
const MAILBOXES = [
  { address: OWNER, kind: "personal", fixtures: (f: string) => !isSupport(f) },
  { address: "support@example.com", kind: "shared", fixtures: isSupport },
] as const;

function isSupport(file: string) {
  return file.startsWith("helpdesk-") || file.startsWith("triage-reader-");
}

if (existsSync(".env")) process.loadEnvFile(".env");
const env = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    MAIL_CREDENTIALS_KEY: z.string().min(1),
    GREENMAIL_HOST: z.string().default("localhost"),
    GREENMAIL_IMAP_PORT: z.coerce.number().default(3143),
    GREENMAIL_SMTP_PORT: z.coerce.number().default(3025),
    MAIL_SERVICE_URL: z.url().optional(),
    MAIL_SERVICE_HMAC_SECRET: z.string().min(32).optional(),
  })
  .parse(process.env);

const keyring = parseKeyring(env.MAIL_CREDENTIALS_KEY);
const { db, close } = createDb(env.DATABASE_URL, { onnotice: () => {} });
try {
  const org = await createOrgWithOwner(db, {
    name: "Omni Dev",
    slug: "omni-dev",
    ownerEmail: OWNER,
    ownerName: "Dev",
  });
  // An active subscription, so triage runs and thread actions are not refused (402). It has no
  // Stripe ids, so billing reconciliation never touches it. `PLAN_NAME` in @omni/auth.
  const [subscribed] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, org.orgId));
  if (!subscribed) {
    await db
      .insert(subscriptions)
      .values({ id: randomUUIDv7(), orgId: org.orgId, plan: "omnipresent", status: "active" });
  }
  for (const mailbox of MAILBOXES) {
    const credentials: PasswordCredentials = {
      user: mailbox.address,
      pass: "dev",
      imap: { host: env.GREENMAIL_HOST, port: env.GREENMAIL_IMAP_PORT, secure: false },
      smtp: { host: env.GREENMAIL_HOST, port: env.GREENMAIL_SMTP_PORT, secure: false },
    };
    const id = (await findMailboxByAddress(db, org.orgId, mailbox.address)) ?? randomUUIDv7();
    await saveMailbox(db, {
      id,
      orgId: org.orgId,
      address: mailbox.address,
      kind: mailbox.kind,
      provider: "imap",
      credentialsEnc: await sealCredentials(keyring, id, credentials),
      ownerMemberId: org.memberId,
    });
    const appended = await fillInbox(credentials, mailbox.fixtures);
    process.stdout.write(
      `dev:seed: ${mailbox.address} (${mailbox.kind}), ${appended} messages added\n`,
    );
  }
} finally {
  await close();
}
await pingMailService();
process.stdout.write(`dev:seed: done. Sign in as ${OWNER}.\n`);

/** Appends the matching fixtures to an empty INBOX; returns how many it added. */
async function fillInbox(credentials: PasswordCredentials, wanted: (file: string) => boolean) {
  const client = new ImapFlow({
    host: credentials.imap.host,
    port: credentials.imap.port,
    secure: false,
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
  });
  await client.connect();
  try {
    const status = await client.status("INBOX", { messages: true });
    if (status && status.messages) return 0;
    const files = readdirSync(fixtures).filter((f) => f.endsWith(".eml") && wanted(f));
    for (const file of files) await client.append("INBOX", readFileSync(join(fixtures, file)));
    return files.length;
  } finally {
    await client.logout();
  }
}

/** A running mail service connects new mailboxes at once; otherwise on its next sync interval. */
async function pingMailService() {
  const { MAIL_SERVICE_URL: url, MAIL_SERVICE_HMAC_SECRET: secret } = env;
  if (!url || !secret) return;
  const headers = await signRequest({ secret, method: "POST", path: MAIL_PING_PATH });
  await fetch(new URL(MAIL_PING_PATH, url), { method: "POST", headers }).catch(() => null);
}

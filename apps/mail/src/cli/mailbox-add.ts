// Adds a mailbox, or replaces its credentials: `pnpm --filter @omni/mail mailbox:add ...`.
// The app password is read from stdin (never argv, which lands in shell history), or created
// through the Purelymail API with --create-app-password. It is encrypted with the keyring, bound
// to the mailbox id, and stored with an owner grant. A running service connects it on the next
// signed ping (sent here when MAIL_SERVICE_URL is set) or sync interval.
import { randomUUIDv7 } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { MAIL_PING_PATH } from "@omni/contracts";
import { parseKeyring, signRequest } from "@omni/crypto";
import { createDb, findMailboxByAddress, findMemberByEmail, saveMailbox } from "@omni/db";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { type MailboxCredentials, sealCredentials } from "../credentials.ts";
import type { ServerEndpoint } from "../mailbox-connection.ts";
import { createPurelymailClient, PURELYMAIL_SERVERS } from "../providers/purelymail.ts";

const USAGE = `Usage: mailbox:add --org <org id> --address <email> --owner <member email> [options]

  --kind personal|shared        default personal
  --provider purelymail|imap    default purelymail
  --user <login>                IMAP/SMTP login; default the address
  --imap host:port[:starttls]   required for --provider imap; without :starttls the port
  --smtp host:port[:starttls]   speaks implicit TLS (993/465). :plain is the same as :starttls
  --create-app-password         purelymail only: create one with PURELYMAIL_API_TOKEN
  --no-verify                   skip the IMAP login check
Without --create-app-password the app password is read from stdin.`;

const env = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  MAIL_CREDENTIALS_KEY: z.string().min(1),
  PURELYMAIL_API_TOKEN: z.string().min(1).optional(),
  MAIL_SERVICE_URL: z.url().optional(),
  MAIL_SERVICE_HMAC_SECRET: z.string().min(32).optional(),
});

function fail(message: string): never {
  console.error(`mailbox:add: ${message}`);
  process.exit(1);
}

function endpoint(value: string | undefined, fallback?: ServerEndpoint): ServerEndpoint {
  if (value === undefined) {
    if (fallback) return fallback;
    fail(`--imap and --smtp are required for this provider\n\n${USAGE}`);
  }
  const [host, port, mode, ...rest] = value.split(":");
  const parsed = Number(port);
  if (!host || !Number.isInteger(parsed) || parsed <= 0 || rest.length > 0) {
    fail(`bad server "${value}": expected host:port[:starttls]`);
  }
  if (mode !== undefined && mode !== "starttls" && mode !== "plain") {
    fail(`bad server mode "${mode}": use starttls`);
  }
  return { host, port: parsed, secure: mode === undefined };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) console.error("App password (end with Ctrl-D):");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function verifyLogin(credentials: MailboxCredentials): Promise<void> {
  const client = new ImapFlow({
    host: credentials.imap.host,
    port: credentials.imap.port,
    secure: credentials.imap.secure,
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
  });
  try {
    await client.connect();
    await client.logout();
  } catch (error) {
    client.close();
    fail(`IMAP login to ${credentials.imap.host} failed: ${(error as Error).message}`);
  }
}

if (existsSync(".env")) process.loadEnvFile(".env");
const config = env.safeParse(process.env);
if (!config.success) {
  fail(`missing or invalid: ${config.error.issues.map((i) => i.path.join(".")).join(", ")}`);
}

// `pnpm mailbox:add -- --org ...` forwards the `--` itself; drop it.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    org: { type: "string" },
    address: { type: "string" },
    owner: { type: "string" },
    kind: { type: "string", default: "personal" },
    provider: { type: "string", default: "purelymail" },
    user: { type: "string" },
    imap: { type: "string" },
    smtp: { type: "string" },
    "create-app-password": { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (!values.org || !values.address || !values.owner) fail(`missing arguments\n\n${USAGE}`);
const kind = z.enum(["personal", "shared"]).safeParse(values.kind);
const provider = z.enum(["purelymail", "imap"]).safeParse(values.provider);
if (!kind.success) fail("--kind must be personal or shared");
if (!provider.success) fail("--provider must be purelymail or imap");

const address = values.address.toLowerCase();
const defaults = provider.data === "purelymail" ? PURELYMAIL_SERVERS : undefined;
const imap = endpoint(values.imap, defaults?.imap);
const smtp = endpoint(values.smtp, defaults?.smtp);
const keyring = (() => {
  try {
    return parseKeyring(config.data.MAIL_CREDENTIALS_KEY);
  } catch (error) {
    return fail(`MAIL_CREDENTIALS_KEY: ${(error as Error).message}`);
  }
})();

let pass: string;
if (values["create-app-password"]) {
  if (provider.data !== "purelymail") fail("--create-app-password needs --provider purelymail");
  if (!config.data.PURELYMAIL_API_TOKEN) fail("--create-app-password needs PURELYMAIL_API_TOKEN");
  pass = await createPurelymailClient(config.data.PURELYMAIL_API_TOKEN).createAppPassword(
    values.user ?? address,
    "Omni",
  );
} else {
  pass = await readStdin();
  if (!pass) fail("no app password on stdin");
}

const credentials: MailboxCredentials = { user: values.user ?? address, pass, imap, smtp };
if (!values["no-verify"]) await verifyLogin(credentials);

const { db, close } = createDb(config.data.DATABASE_URL, { onnotice: () => {} });
try {
  const ownerMemberId = await findMemberByEmail(db, values.org, values.owner);
  if (!ownerMemberId) fail(`no member with email ${values.owner} in org ${values.org}`);
  const mailboxId = (await findMailboxByAddress(db, values.org, address)) ?? randomUUIDv7();
  await saveMailbox(db, {
    id: mailboxId,
    orgId: values.org,
    address,
    kind: kind.data,
    provider: provider.data,
    credentialsEnc: await sealCredentials(keyring, mailboxId, credentials),
    ownerMemberId,
  });
  process.stdout.write(
    `${JSON.stringify({ mailboxId, address, kind: kind.data, provider: provider.data })}\n`,
  );
} finally {
  await close();
}

const { MAIL_SERVICE_URL: serviceUrl, MAIL_SERVICE_HMAC_SECRET: secret } = config.data;
if (serviceUrl && secret) {
  const headers = await signRequest({ secret, method: "POST", path: MAIL_PING_PATH });
  const response = await fetch(new URL(MAIL_PING_PATH, serviceUrl), {
    method: "POST",
    headers,
  }).catch(() => null);
  console.error(
    response?.status === 202
      ? "mail service pinged: it connects the mailbox now"
      : "mail service not reachable: it connects the mailbox on its next sync interval",
  );
}

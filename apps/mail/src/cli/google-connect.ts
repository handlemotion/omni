import { createHash, randomBytes } from "node:crypto";
import { existsSync, fstatSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { GOOGLE_CONNECT_PATH, googleConnectResultSchema } from "@omni/contracts";
import { signRequest } from "@omni/crypto";
import { createDb, findMemberByEmail } from "@omni/db";
import { z } from "zod";
import { createGoogleOAuth, GOOGLE_SCOPE_PARAM } from "../providers/gmail.ts";

const USAGE = `Usage: google:connect --org <org id> --owner <member email> [--port 8790]
       google:connect --pipe-refresh-token [--port 8790] | <secret store>

Needs GOOGLE_CLIENT_ID. Connecting also needs DATABASE_URL, MAIL_SERVICE_URL and
MAIL_SERVICE_HMAC_SECRET (a running mail service); --pipe-refresh-token needs GOOGLE_CLIENT_SECRET.`;

function fail(message: string): never {
  console.error(`google:connect: ${message}`);
  process.exit(1);
}

if (existsSync(".env")) process.loadEnvFile(".env");
const env = z
  .object({
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    DATABASE_URL: z.url().optional(),
    MAIL_SERVICE_URL: z.url().optional(),
    MAIL_SERVICE_HMAC_SECRET: z.string().min(32).optional(),
  })
  .safeParse(process.env);
if (!env.success) fail(`missing or invalid: ${env.error.issues.map((i) => i.path).join(", ")}`);

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    org: { type: "string" },
    owner: { type: "string" },
    port: { type: "string", default: "8790" },
    "pipe-refresh-token": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const pipeToken = values["pipe-refresh-token"];
if (!pipeToken && (!values.org || !values.owner)) fail(`missing arguments\n\n${USAGE}`);
if (pipeToken && !fstatSync(1).isFIFO()) {
  fail("--pipe-refresh-token writes to a pipe only, e.g. | doppler secrets set NAME");
}

const redirectUri = `http://localhost:${values.port}/callback`;
const state = randomBytes(16).toString("base64url");
const codeVerifier = randomBytes(48).toString("base64url");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: env.data.GOOGLE_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: GOOGLE_SCOPE_PARAM,
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  code_challenge_method: "S256",
}).toString();

const code = await new Promise<string>((resolve) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || (!got && !error)) {
      return void res.writeHead(400).end("Unexpected request.");
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("Done. Back to the terminal.");
    server.close();
    if (error || !got) fail(`Google said: ${JSON.stringify(error)}`);
    resolve(got);
  });
  server.listen(Number(values.port), "127.0.0.1", () => {
    console.error(`Open this URL and allow access:\n\n${authUrl.toString()}\n`);
  });
});

if (pipeToken) {
  if (!env.data.GOOGLE_CLIENT_SECRET) fail("--pipe-refresh-token needs GOOGLE_CLIENT_SECRET");
  const grant = await createGoogleOAuth({
    clientId: env.data.GOOGLE_CLIENT_ID,
    clientSecret: env.data.GOOGLE_CLIENT_SECRET,
  }).exchangeCode({ code, redirectUri, codeVerifier });
  process.stdout.write(grant.refreshToken);
  console.error(`refresh token for ${grant.email} sent down the pipe`);
  process.exit(0);
}

const { DATABASE_URL, MAIL_SERVICE_URL, MAIL_SERVICE_HMAC_SECRET } = env.data;
if (!DATABASE_URL || !MAIL_SERVICE_URL || !MAIL_SERVICE_HMAC_SECRET) {
  fail("connecting needs DATABASE_URL, MAIL_SERVICE_URL and MAIL_SERVICE_HMAC_SECRET");
}
const { db, close } = createDb(DATABASE_URL, { onnotice: () => {} });
const memberId = await findMemberByEmail(db, values.org!, values.owner!).finally(close);
if (!memberId) fail(`no member with email ${values.owner} in org ${values.org}`);

const body = JSON.stringify({ orgId: values.org, memberId, code, codeVerifier, redirectUri });
const headers = await signRequest({
  secret: MAIL_SERVICE_HMAC_SECRET,
  method: "POST",
  path: GOOGLE_CONNECT_PATH,
  body,
  nonce: randomBytes(16).toString("hex"),
});
const response = await fetch(new URL(GOOGLE_CONNECT_PATH, MAIL_SERVICE_URL), {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body,
});
const json: unknown = await response.json().catch(() => null);
const result = googleConnectResultSchema.safeParse(json);
if (!response.ok || !result.success)
  fail(`mail service answered ${response.status}: ${JSON.stringify(json)}`);
process.stdout.write(`${JSON.stringify(result.data)}\n`);

import { createServer } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  CookieJar,
  createTestDatabase,
  sentMail,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let alias: string;

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  alias = `http://127.0.0.1:${port}`;
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: {
      BETTER_AUTH_URL: "https://blocked.example",
      AUTH_TRUSTED_ORIGINS: "https://blocked.example",
      AUTH_PASSKEY_RP_ID: "blocked.example",
      AUTH_ALIAS_ORIGINS: alias,
      GOOGLE_CLIENT_ID: "e2e-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
    },
  });
});

afterAll(async () => {
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

function post(jar: CookieJar, path: string, body: unknown) {
  return fetch(new URL(`/api/auth${path}`, alias), {
    method: "POST",
    headers: { "content-type": "application/json", origin: alias, cookie: jar.header },
    body: JSON.stringify(body),
  }).then((response) => jar.store(response));
}

test("on an alias origin, Google returns to that origin, not BETTER_AUTH_URL", async () => {
  const started = await post(new CookieJar(), "/sign-in/social", {
    provider: "google",
    callbackURL: "/inbox",
  });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  expect(new URL(url).searchParams.get("redirect_uri")).toBe(`${alias}/api/auth/callback/google`);
});

test("on an alias origin, the web app signs in with a code and makes passkeys for that host", async () => {
  const jar = new CookieJar();
  const email = "alias@example.com";
  expect(
    (await post(jar, "/email-otp/send-verification-otp", { email, type: "sign-in" })).status,
  ).toBe(200);
  const otp = await codeFor(email);
  expect((await post(jar, "/sign-in/email-otp", { email, otp })).status).toBe(200);

  const options = await fetch(new URL("/api/auth/passkey/generate-register-options", alias), {
    headers: { cookie: jar.header, origin: alias },
  });
  expect(options.status).toBe(200);
  expect(((await options.json()) as { rp: { id: string } }).rp.id).toBe("127.0.0.1");
});

async function codeFor(email: string) {
  const otp = (await sentMail({ url: alias }, email)).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  if (!otp) throw new Error(`no sign-in code sent to ${email}`);
  return otp;
}

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      WEB_APP_URL: `http://127.0.0.1:${port}`,
      RATE_LIMIT_AUTH: "off",
    },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("one press of Confirm sends the agent back with a code that grants every requested scope", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `consent-${Date.now()}@studio.test`;
  await createMember(db, org.id, email);
  const cookie = await signIn({ url: new URL(origin) }, db, email);

  const agent = await agentCallback();
  const redirectUri = agent.url;
  const registered = await fetch(new URL("/api/auth/oauth2/register", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const scope = "mail:read mail:triage mail:draft crm:read crm:write drive:read offline_access";
  const authorize = new URL("/api/auth/oauth2/authorize", origin);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    scope,
    state: "state-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: new URL("/mcp", origin).toString(),
  }).toString();

  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(authorize.toString());
  await page.getByRole("button", { name: "Confirm" }).click();
  const back = await Promise.race([
    agent.received,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  expect(back?.searchParams.get("code")).toBeTruthy();
  await context.close();
  await agent.close();

  const token = await fetch(new URL("/api/auth/oauth2/token", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back!.searchParams.get("code")!,
      redirect_uri: redirectUri,
      client_id,
      code_verifier: verifier,
      resource: new URL("/mcp", origin).toString(),
    }),
  });
  expect(token.status).toBe(200);
  const granted = ((await token.json()) as { scope: string }).scope.split(" ");
  expect(granted).toEqual(expect.arrayContaining(scope.split(" ")));
});

test("the icons agents and search engines show are the current ones, served as images", async () => {
  for (const [path, type] of [
    ["/favicon.ico", "image/"],
    ["/favicon.svg", "image/svg+xml"],
    ["/icon-192.png", "image/png"],
  ] as const) {
    const response = await fetch(new URL(path, String(worker.url)));
    expect([path, response.status, response.headers.get("content-type")?.startsWith(type)]).toEqual(
      [path, 200, true],
    );
  }
});

async function agentCallback() {
  let resolve: (url: URL) => void = () => {};
  const received = new Promise<URL>((done) => (resolve = done));
  const server = createServer((request, response) => {
    resolve(new URL(request.url ?? "/", "http://127.0.0.1"));
    response.end("back at the agent");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/callback`,
    received,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

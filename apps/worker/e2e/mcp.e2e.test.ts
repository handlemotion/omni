// People's own agents over MCP (ADR 0029): the real OAuth flow an agent goes through (register,
// PKCE, sign in, pick a workspace, consent, token) against the real Worker under workerd and a
// real Postgres, then tool calls through the official MCP client. No step is stubbed: tokens are
// signed by our provider and checked by the endpoint as a client would present them.
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CookieJar,
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

const BASE = "http://localhost:8787";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:43123/callback";

let cleanup: () => Promise<void>;
let worker: { url: string };
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];

beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  const mail = await startMailServiceEndpoint();
  const started = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mail.url,
    vars: { SYSTEM_MAIL_FROM },
  });
  worker = { url: started.url.toString() };
  cleanup = async () => {
    await started.server.close();
    await mail.close();
    await database.teardown();
  };
}, 120_000);

afterAll(() => cleanup?.());

const at = (path: string) => new URL(path, worker.url);

/** What a browser sends when it follows a link or a redirect, not a script's fetch. */
const NAVIGATION = { accept: "text/html", "sec-fetch-mode": "navigate" };

/**
 * Where an authorization step sends the browser. A real navigation gets a 302; Node's `fetch`
 * overrides `Sec-Fetch-Mode`, so here the provider answers its JSON form of the same redirect.
 */
async function nextStep(response: Response) {
  if (response.status === 302) return new URL(response.headers.get("location")!);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { redirect: boolean; url: string };
  expect(body.redirect).toBe(true);
  return new URL(body.url);
}

/** A browser call from the web app: same origin, with the jar's cookies. */
function browser(jar: CookieJar, path: string, init: RequestInit = {}) {
  return fetch(at(path), {
    ...init,
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: jar.header, ...init.headers },
  });
}

async function registerClient() {
  const response = await fetch(at("/api/auth/oauth2/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test agent",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, scope: string, resource = RESOURCE) {
  const url = at("/api/auth/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(resource ? { resource } : {}),
  }).toString();
  return url;
}

/**
 * Everything an agent does to connect, as the signed-in person in `jar`: returns its tokens.
 * `workspace` is the consent screen's pick (null: every workspace).
 */
async function connect(
  jar: CookieJar,
  options: { workspace?: string | null; scope?: string; resource?: string } = {},
) {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const scope = options.scope ?? "openid mail:read offline_access";

  const url = authorizeUrl(clientId, challenge, scope, options.resource);
  const authorize = await browser(jar, url.pathname + url.search, { headers: NAVIGATION });
  const consentPage = await nextStep(authorize);
  expect(consentPage.pathname).toBe("/oauth/consent");

  const picked = await browser(jar, "/api/oauth/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: options.workspace ?? null }),
  });
  expect(picked.status).toBe(200);

  const consent = await browser(jar, "/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
  });
  expect(consent.status).toBe(200);
  const back = new URL(((await consent.json()) as { url: string }).url);
  expect(back.origin + back.pathname).toBe(REDIRECT_URI);
  // RFC 9207: the agent can check who issued the code.
  expect(back.searchParams.get("iss")).toBe(`${BASE}/api/auth`);

  const token = await fetch(at("/api/auth/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      ...(options.resource === "" ? {} : { resource: options.resource ?? RESOURCE }),
    }),
  });
  expect(token.status).toBe(200);
  return {
    clientId,
    ...((await token.json()) as { access_token: string; refresh_token?: string; scope: string }),
  };
}

/** The official MCP client, connected with `token`. */
async function agent(token: string) {
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(at("/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

interface Inbox {
  me: { email: string };
  workspaces: { id: string }[];
  mailboxes: { id: string; address: string; inbox: number; unread: number }[];
  attention: { id: string; subject: string; url: string; mailbox: string; unread: boolean }[];
}

async function inbox(token: string, args: Record<string, unknown> = {}) {
  const client = await agent(token);
  try {
    const result = await client.callTool({ name: "inbox", arguments: args });
    expect(result.isError).toBeFalsy();
    return result.structuredContent as unknown as Inbox;
  } finally {
    await client.close();
  }
}

/** A JSON-RPC call the way 2025-era clients (Claude, ChatGPT today) send it, no handshake state. */
function legacyCall(token: string, body: unknown) {
  return fetch(at("/mcp"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
}

describe("discovery", () => {
  // Catches: a client never learning where to sign in (Claude only starts on a real 401).
  test("an unauthenticated call is a 401 pointing at the resource metadata", async () => {
    const response = await fetch(at("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mail:read"`,
    );
    const metadata = (await (
      await fetch(at("/.well-known/oauth-protected-resource/mcp"))
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(metadata.resource).toBe(RESOURCE);
    // RFC 8414: the issuer's path goes after the well-known prefix.
    const issuerPath = new URL(metadata.authorization_servers[0]!).pathname;
    const server = (await (
      await fetch(at(`/.well-known/oauth-authorization-server${issuerPath}`))
    ).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: `${BASE}/api/auth`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(server.token_endpoint_auth_methods_supported).toContain("none");
  });

  // Catches: a signed-out person stranded on a login page that forgets the agent's request.
  test("signing in returns to the agent's authorization request", async () => {
    const clientId = await registerClient();
    const url = authorizeUrl(clientId, "x".repeat(43), "openid mail:read");
    const loginStep = await nextStep(await fetch(url, { redirect: "manual", headers: NAVIGATION }));
    expect(loginStep.pathname).toBe("/api/oauth/login");
    const login = await fetch(at(loginStep.pathname + loginStep.search), {
      redirect: "manual",
      headers: NAVIGATION,
    });
    expect(login.status).toBe(302);
    const page = new URL(login.headers.get("location")!);
    expect(page.pathname).toBe("/login");
    const next = new URL(page.searchParams.get("redirect")!, BASE);
    expect(next.pathname).toBe("/api/auth/oauth2/authorize");
    expect(next.searchParams.get("client_id")).toBe(clientId);
    expect(next.searchParams.get("code_challenge")).toBe("x".repeat(43));
    // Only the client's own request goes back: the provider re-signs it.
    expect(
      [...next.searchParams.keys()].filter(
        (k) => k === "sig" || k === "exp" || k.startsWith("ba_"),
      ),
    ).toEqual([]);
  });
});

describe("a connected agent", () => {
  let token: string;
  let mailboxAddress: string;
  let threadId: string;
  let otherThreadId: string;

  beforeAll(async () => {
    const org = await createOrg(db, "acme");
    const member = await createMember(db, org.id, "ana@acme.test");
    const mailbox = await createMailbox(db, org.id, "ana@acme.test", "personal");
    await grant(db, org.id, mailbox.id, member.id);
    mailboxAddress = mailbox.address;
    ({ threadId } = await seedMessage(db, mailbox, {
      subject: "Invoice 4411 failed",
      fromAddress: "billing@stripe.test",
      fromName: "Stripe",
      uid: 1,
      text: "Your payment for invoice 4411 failed. Update your card.",
    }));

    // Someone else's inbox in another workspace: never visible to Ana's agent.
    const other = await createOrg(db, "globex");
    const bob = await createMember(db, other.id, "bob@globex.test");
    const bobBox = await createMailbox(db, other.id, "bob@globex.test", "personal");
    await grant(db, other.id, bobBox.id, bob.id);
    ({ threadId: otherThreadId } = await seedMessage(db, bobBox, {
      subject: "Globex secret plans",
      fromAddress: "ceo@globex.test",
      uid: 1,
    }));

    const jar = new CookieJar();
    await signIn(worker, db, "ana@acme.test", jar);
    ({ access_token: token } = await connect(jar));
  });

  // Catches: an agent that connects but cannot read, or reads someone else's mail.
  test("inbox shows the person's mail and nobody else's", async () => {
    const result = await inbox(token);
    expect(result.me.email).toBe("ana@acme.test");
    expect(result.mailboxes.map((m) => m.address)).toEqual([mailboxAddress]);
    expect(result.mailboxes[0]).toMatchObject({ inbox: 1, unread: 1 });
    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      id: threadId,
      subject: "Invoice 4411 failed",
      mailbox: mailboxAddress,
      unread: true,
      url: `${WEB_ORIGIN}/all/${threadId}`,
    });
    expect(JSON.stringify(result)).not.toContain(otherThreadId);
  });

  // Catches: breaking the clients that still speak the 2025 protocol (Claude, ChatGPT).
  test("2025-era clients list and call tools without a session", async () => {
    const initialize = await legacyCall(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      },
    });
    expect(initialize.status).toBe(200);
    const listed = await legacyCall(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await listed.text();
    expect(body).toContain('"name":"inbox"');
    expect(body).toContain('"readOnlyHint":true');
    const called = await legacyCall(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inbox", arguments: { limit: 1 } },
    });
    expect(await called.text()).toContain("Invoice 4411 failed");
  });

  // Catches: an `inbox` filter that leaks or errors instead of telling the agent what to do.
  test("an inbox the person cannot open is an actionable tool error", async () => {
    const client = await agent(token);
    const result = await client.callTool({
      name: "inbox",
      arguments: { mailbox: "bob@globex.test" },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Call `inbox` without `mailbox`");
  });

  // Catches: accepting a forged token or one minted for another resource (token passthrough).
  test("a token that is not ours for /mcp is a 401", async () => {
    const [header, payload] = token.split(".");
    const forged = `${header}.${payload}.${"A".repeat(86)}`;
    const response = await legacyCall(forged, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("what a grant reaches", () => {
  // Catches: a one-workspace grant reading every workspace, the consent screen's whole promise.
  test("a grant for one workspace reads only that workspace", async () => {
    const work = await createOrg(db, "work");
    const side = await createOrg(db, "side");
    const member = await createMember(db, work.id, "cara@work.test");
    const [sideMember] = await db
      .insert(schema.members)
      .values({
        id: crypto.randomUUID(),
        organizationId: side.id,
        userId: member.userId,
        createdAt: new Date(),
      })
      .returning();
    const workBox = await createMailbox(db, work.id, "cara@work.test", "personal");
    const sideBox = await createMailbox(db, side.id, "cara@side.test", "personal");
    await grant(db, work.id, workBox.id, member.id);
    await grant(db, side.id, sideBox.id, sideMember!.id);

    const jar = new CookieJar();
    await signIn(worker, db, "cara@work.test", jar);
    const everything = await connect(jar);
    expect((await inbox(everything.access_token)).mailboxes.map((m) => m.address).sort()).toEqual([
      "cara@side.test",
      "cara@work.test",
    ]);
    const workOnly = await connect(jar, { workspace: work.id });
    const result = await inbox(workOnly.access_token);
    expect(result.mailboxes.map((m) => m.address)).toEqual(["cara@work.test"]);
    expect(result.workspaces.map((w) => w.id)).toEqual([work.id]);
  });

  // Catches: picking a workspace that is not yours to widen a grant.
  test("a workspace the person is not in cannot be picked", async () => {
    const theirs = await createOrg(db, "theirs");
    const mine = await createOrg(db, "mine");
    await createMember(db, mine.id, "dan@mine.test");
    const jar = new CookieJar();
    await signIn(worker, db, "dan@mine.test", jar);
    const picked = await browser(jar, "/api/oauth/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: theirs.id }),
    });
    expect(picked.status).toBe(403);
  });

  // Catches: a removed teammate's agent still reading the company's mail until its token expires.
  test("leaving a workspace cuts its mail off a live token at once", async () => {
    const org = await createOrg(db, "leaving");
    const member = await createMember(db, org.id, "eve@leaving.test");
    const box = await createMailbox(db, org.id, "eve@leaving.test", "personal");
    await grant(db, org.id, box.id, member.id);
    const jar = new CookieJar();
    await signIn(worker, db, "eve@leaving.test", jar);
    const { access_token } = await connect(jar);
    expect((await inbox(access_token)).mailboxes).toHaveLength(1);

    await db
      .delete(schema.members)
      .where(and(eq(schema.members.id, member.id), eq(schema.members.organizationId, org.id)));
    expect((await inbox(access_token)).mailboxes).toHaveLength(0);
  });

  // Catches: a token without mail access reading mail; the client must be told what to ask for.
  test("a token without mail:read is asked to step up", async () => {
    const org = await createOrg(db, "stepup");
    await createMember(db, org.id, "fay@stepup.test");
    const jar = new CookieJar();
    await signIn(worker, db, "fay@stepup.test", jar);
    const { access_token } = await connect(jar, { scope: "openid" });
    const response = await legacyCall(access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="mail:read"');
  });
});

// People's own agents over MCP (ADR 0029): the real OAuth flow an agent goes through (register,
// PKCE, sign in, pick a workspace, consent, token) against the real Worker under workerd and a
// real Postgres, then tool calls through the official MCP client. No step is stubbed: tokens are
// signed by our provider and checked by the endpoint as a client would present them.
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ensurePersonalSpace, forMember, schema } from "@omni/db";
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
    // A rate limit low enough that one test can use it up with full triage batches, thread links
    // on the web app's origin whatever a local .dev.vars says, and no per-address auth limit:
    // many people sign in and connect from one address here.
    vars: {
      SYSTEM_MAIL_FROM,
      RATE_LIMIT_ACTIONS: "60/60",
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
    },
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

/** One tool call through the official client: its structured result, or its error text. */
interface SearchResult {
  results: {
    id: string;
    title: string;
    url: string;
    mailbox: string;
    snippet: string;
    unread: boolean;
    lane: string | null;
  }[];
  ranking: string;
  next_cursor?: string;
}

interface FetchedThread {
  id: string;
  text: string;
  metadata: {
    truncated: boolean;
    messages: { from_me: boolean }[];
    conversation?: { status: string; assignee: string | null };
  };
}

type FetchResult = FetchedThread & { more?: FetchedThread[]; not_found?: string[] };

async function tool<T = unknown>(token: string, name: string, args: Record<string, unknown>) {
  const client = await agent(token);
  try {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      data: result.structuredContent as T,
      text: JSON.stringify(result.content),
    };
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

    // No argument widens it: an empty or other workspace is refused by every tool.
    await seedMessage(db, sideBox, { subject: "Side project", fromAddress: "x@side.test", uid: 1 });
    for (const [name, args] of [
      ["inbox", { workspace: "" }],
      ["search", { query: "", view: "all", workspace: "" }],
      ["search", { query: "", view: "all", workspace: side.id }],
    ] as const) {
      const call = await tool(workOnly.access_token, name, args);
      expect(call.isError).toBe(true);
      expect(call.text).not.toContain("Side project");
    }
    const listed = await tool<SearchResult>(workOnly.access_token, "search", {
      query: "",
      view: "all",
    });
    expect(listed.data.results.map((r) => r.mailbox)).not.toContain("cara@side.test");
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

describe("finding and reading mail", () => {
  let token: string;
  let invoice: string;
  let lunch: string;
  let ticket: string;
  let strangers: string;

  beforeAll(async () => {
    const org = await createOrg(db, "readers");
    const gil = await createMember(db, org.id, "gil@readers.test");
    await db.update(schema.users).set({ name: "Gil" }).where(eq(schema.users.id, gil.userId));
    const box = await createMailbox(db, org.id, "gil@readers.test", "personal");
    await grant(db, org.id, box.id, gil.id);
    ({ threadId: invoice } = await seedMessage(db, box, {
      subject: "Invoice 9001 failed",
      fromAddress: "billing@mail.stripe.test",
      fromName: "Stripe",
      to: ["gil@readers.test"],
      uid: 1,
      sentAt: new Date("2026-10-01T10:00:00Z"),
      text: "Your payment for invoice 9001 failed. Update your card by Friday.",
    }));
    await seedMessage(db, box, {
      subject: "Re: Invoice 9001 failed",
      fromAddress: "gil@readers.test",
      to: ["billing@mail.stripe.test"],
      uid: 2,
      threadId: invoice,
      sentAt: new Date("2026-10-02T10:00:00Z"),
      text: "Card updated, please retry the charge.",
    });
    ({ threadId: lunch } = await seedMessage(db, box, {
      subject: "Lunch on Friday",
      fromAddress: "maya@friends.test",
      uid: 3,
      sentAt: new Date("2026-10-03T10:00:00Z"),
      text: `Lunch on Friday? ${"We could try the new place by the river. ".repeat(80)}`,
    }));

    // A shared inbox Gil works in: its conversation state comes with the thread.
    const desk = await createMailbox(db, org.id, "help@readers.test", "shared");
    await grant(db, org.id, desk.id, gil.id);
    ({ threadId: ticket } = await seedMessage(db, desk, {
      subject: "Order 77 never arrived",
      fromAddress: "customer@shop.test",
      uid: 1,
      text: "My order 77 never arrived.",
    }));
    await db
      .update(schema.threads)
      .set({ assigneeMemberId: gil.id, status: "pending" })
      .where(eq(schema.threads.id, ticket));

    // Someone else's mail with the same words: never found, never read.
    const elsewhere = await createOrg(db, "elsewhere");
    const hal = await createMember(db, elsewhere.id, "hal@elsewhere.test");
    const halBox = await createMailbox(db, elsewhere.id, "hal@elsewhere.test", "personal");
    await grant(db, elsewhere.id, halBox.id, hal.id);
    ({ threadId: strangers } = await seedMessage(db, halBox, {
      subject: "Invoice 9001 failed",
      fromAddress: "billing@mail.stripe.test",
      uid: 1,
      text: "Their invoice 9001 failed too.",
    }));

    const jar = new CookieJar();
    await signIn(worker, db, "gil@readers.test", jar);
    ({ access_token: token } = await connect(jar));
  });

  // Catches: search that misses the person's own mail, returns another person's, or loses the
  // fields ChatGPT's deep research needs (id, title, url).
  test("search by words finds the person's thread, in ChatGPT's shape", async () => {
    const { data, isError } = await tool<SearchResult>(token, "search", { query: "invoice 9001" });
    expect(isError).toBe(false);
    expect(data.results.map((r) => r.id)).toEqual([invoice]);
    expect(data.results[0]).toMatchObject({
      title: expect.stringContaining("Invoice 9001"),
      url: `${WEB_ORIGIN}/all/${invoice}`,
      mailbox: "gil@readers.test",
    });
    expect(JSON.stringify(data)).not.toContain(strangers);
  });

  // Catches: a filter ignored by search, so "what did Stripe send" returns everything.
  test("filters narrow a search and a listing", async () => {
    const fromStripe = await tool<SearchResult>(token, "search", {
      query: "friday",
      from: "stripe.test",
    });
    expect(fromStripe.data.results.map((r) => r.id)).toEqual([invoice]);
    const listed = await tool<SearchResult>(token, "search", {
      query: "",
      participant: "friends.test",
    });
    expect(listed.data).toMatchObject({ ranking: "newest" });
    expect(listed.data.results.map((r) => r.id)).toEqual([lunch]);
    const helpdesk = await tool<SearchResult>(token, "search", {
      query: "",
      status: "pending",
      view: "all",
    });
    expect(helpdesk.data.results.map((r) => r.id)).toEqual([ticket]);
    const bad = await tool<SearchResult>(token, "search", { query: "", from: "%" });
    expect(bad.isError).toBe(true);
  });

  // Catches: a cursor that repeats or skips threads when an agent pages through a listing.
  test("a listing pages with next_cursor without repeats", async () => {
    const first = await tool<SearchResult>(token, "search", { query: "", view: "all", limit: 2 });
    expect(first.data.results).toHaveLength(2);
    const second = await tool<SearchResult>(token, "search", {
      query: "",
      view: "all",
      limit: 2,
      cursor: first.data.next_cursor,
    });
    const seen = [...first.data.results, ...second.data.results].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([invoice, lunch, ticket].sort());
    expect(second.data.next_cursor).toBeUndefined();
  });

  // Catches: reading someone else's thread by guessing its id, or a batch that drops the rest
  // when one id is bad.
  test("fetch reads a batch of the person's threads and nobody else's", async () => {
    const { data } = await tool<FetchResult>(token, "fetch", {
      id: invoice,
      ids: [ticket, strangers],
    });
    expect(data.id).toBe(invoice);
    expect(data.text).toContain("From: Stripe <billing@mail.stripe.test>");
    expect(data.text).toContain("Card updated, please retry the charge.");
    expect(data.metadata.messages.map((m) => m.from_me)).toEqual([false, true]);
    expect(data.more!.map((d) => d.id)).toEqual([ticket]);
    expect(data.more![0]!.metadata.conversation).toMatchObject({
      status: "pending",
      assignee: "Gil",
    });
    expect(data.not_found).toEqual([strangers]);
    expect(JSON.stringify(data)).not.toContain("Their invoice");

    const alone = await tool<FetchResult>(token, "fetch", { id: strangers });
    expect(alone.isError).toBe(true);
    expect(alone.text).not.toContain("Their invoice");
  });

  // Catches: a long thread blowing past the agent's context instead of giving way oldest first.
  test("fetch keeps to max_chars, cutting the oldest messages first", async () => {
    const { data } = await tool<FetchResult>(token, "fetch", {
      id: invoice,
      ids: [lunch],
      max_chars: 2_000,
    });
    const all = `${data.text}${data.more![0]!.text}`;
    expect(all.length).toBeLessThanOrEqual(2_000);
    expect(data.text).toMatch(/earlier message.* not shown/i);
    expect(data.text).toContain("Card updated, please retry the charge.");
    expect(data.more![0]!.metadata.truncated).toBe(true);
  });
});

// Catches: fetch returning far more text than max_chars when many threads share a small budget
// (a fixed minimum per thread, headers and notices that never shrink), flooding the agent's context.
test("fetch keeps ten long threads within max_chars", async () => {
  const org = await createOrg(db, "budget");
  const ivy = await createMember(db, org.id, "ivy@budget.test");
  const box = await createMailbox(db, org.id, "ivy@budget.test", "personal");
  await grant(db, org.id, box.id, ivy.id);
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const { threadId } = await seedMessage(db, box, {
      subject: `Long report ${i}`,
      fromAddress: `writer${i}@reports.test`,
      uid: 2 * i + 1,
      sentAt: new Date(Date.UTC(2026, 9, 1, i)),
      text: "Old context. ".repeat(500),
    });
    await seedMessage(db, box, {
      subject: `Re: Long report ${i}`,
      fromAddress: `writer${i}@reports.test`,
      uid: 2 * i + 2,
      threadId,
      sentAt: new Date(Date.UTC(2026, 9, 2, i)),
      text: `Report ${i} body. `.repeat(600),
    });
    ids.push(threadId);
  }
  const jar = new CookieJar();
  await signIn(worker, db, "ivy@budget.test", jar);
  const { access_token } = await connect(jar);
  const [first, ...rest] = ids;
  const { data, isError } = await tool<FetchResult>(access_token, "fetch", {
    id: first,
    ids: rest,
    max_chars: 2_000,
  });
  expect(isError).toBe(false);
  const documents = [data, ...(data.more ?? [])];
  expect(documents).toHaveLength(10);
  expect(documents.reduce((sum, d) => sum + d.text.length, 0)).toBeLessThanOrEqual(2_000);
  for (const document of documents) {
    expect(document.text).toContain("From: writer");
    expect(document.metadata.truncated).toBe(true);
  }
});

// Catches: a newsletter read as a wall of tracking links (snippets that are only URLs, `fetch`
// text that spends the budget on redirects), and word search dropping the read and lane state
// the listing returns.
test("agents read newsletters without tracking links, and word search keeps thread state", async () => {
  const org = await createOrg(db, "letters");
  const uma = await createMember(db, org.id, "uma@letters.test");
  const box = await createMailbox(db, org.id, "uma@letters.test", "personal");
  await grant(db, org.id, box.id, uma.id);
  const tracker = `https://track.letters.test/click/${"a1b2c3d4".repeat(16)}`;
  const { threadId } = await seedMessage(db, box, {
    subject: "Your weekly digest",
    fromAddress: "digest@news.letters.test",
    uid: 1,
    text: [
      `${tracker}${tracker}`,
      `Read the digest ( ${tracker} ) or reply to editor@letters.test.`,
      "Archive ( https://letters.test/archive )",
      `Notification preferences (  ) ${tracker}`,
    ].join("\n"),
  });
  await db
    .update(schema.threads)
    .set({ triage: "fyi", triageSource: "ai", triageConfidence: 0.95 })
    .where(eq(schema.threads.id, threadId));
  const jar = new CookieJar();
  await signIn(worker, db, "uma@letters.test", jar);
  const { access_token } = await connect(jar);

  const byWords = await tool<SearchResult>(access_token, "search", { query: "weekly digest" });
  const listed = await tool<SearchResult>(access_token, "search", { query: "" });
  for (const found of [byWords.data.results[0], listed.data.results[0]]) {
    expect(found).toMatchObject({ id: threadId, unread: true, lane: "fyi" });
    expect(found!.snippet).toMatch(/^Read the digest .*editor@letters\.test/);
    expect(found!.snippet).not.toContain("http");
  }

  const { data } = await tool<FetchResult>(access_token, "fetch", { id: threadId });
  expect(data.text).not.toContain("track.letters.test");
  expect(data.text).toContain("Read the digest or reply to editor@letters.test.");
  expect(data.text).toContain("Archive ( https://letters.test/archive )");
  expect(data.text).toMatch(/Notification preferences$/m);
});

describe("changing mail", () => {
  let token: string;
  let readOnly: string;
  let member: string;
  let personal: { threadId: string };
  let ticket: string;
  let strangers: string;

  beforeAll(async () => {
    const org = await createOrg(db, "writers");
    const jo = await createMember(db, org.id, "jo@writers.test");
    member = jo.id;
    const box = await createMailbox(db, org.id, "jo@writers.test", "personal");
    await grant(db, org.id, box.id, jo.id);
    personal = await seedMessage(db, box, {
      subject: "Weekly digest",
      fromAddress: "news@digest.test",
      to: ["jo@writers.test"],
      uid: 7,
      text: "This week in widgets.",
    });
    const desk = await createMailbox(db, org.id, "support@writers.test", "shared");
    await grant(db, org.id, desk.id, jo.id);
    ({ threadId: ticket } = await seedMessage(db, desk, {
      subject: "Refund please",
      fromAddress: "buyer@shop.test",
      to: ["support@writers.test"],
      uid: 1,
      text: "I would like a refund.",
    }));
    await db.insert(schema.tags).values({ orgId: org.id, mailboxId: desk.id, name: "Refunds" });

    const other = await createOrg(db, "strangers");
    const kim = await createMember(db, other.id, "kim@strangers.test");
    const kimBox = await createMailbox(db, other.id, "kim@strangers.test", "personal");
    await grant(db, other.id, kimBox.id, kim.id);
    ({ threadId: strangers } = await seedMessage(db, kimBox, {
      subject: "Private",
      fromAddress: "x@strangers.test",
      uid: 1,
    }));

    const jar = new CookieJar();
    await signIn(worker, db, "jo@writers.test", jar);
    ({ access_token: token } = await connect(jar, {
      scope: "openid mail:read mail:triage mail:draft",
    }));
    ({ access_token: readOnly } = await connect(jar));
  });

  /** Another personal inbox for Jo, so its outbox rows are this test's alone. */
  const ownInbox = async (name: string) => {
    const [jo] = await db.select().from(schema.members).where(eq(schema.members.id, member));
    const box = await createMailbox(db, jo!.organizationId, `jo+${name}@writers.test`, "personal");
    await grant(db, jo!.organizationId, box.id, member);
    return box;
  };

  const actionsFor = (threadId: string) =>
    db
      .select({ kind: schema.mailActions.kind })
      .from(schema.mailActions)
      .innerJoin(schema.threads, eq(schema.threads.mailboxId, schema.mailActions.mailboxId))
      .where(eq(schema.threads.id, threadId));

  // Catches: an agent's triage that reports success but changes nothing the app shows, writes
  // state for the wrong person, loses the re-sort the model learns from, or queues the same
  // IMAP move twice when a client retries.
  test("triage files personal mail like the app does, and a retry queues nothing new", async () => {
    const change = {
      thread_id: personal.threadId,
      read: true,
      lane: "fyi",
      later: true,
      archived: true,
    };
    const first = await tool<{ results: { ok: boolean; applied: string[] }[] }>(token, "triage", {
      changes: [change],
    });
    expect(first.data.results[0]).toMatchObject({ ok: true });
    expect(first.data.results[0]!.applied.sort()).toEqual(["archived", "lane", "later", "read"]);

    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, personal.threadId));
    expect(thread).toMatchObject({ archived: true, triage: "fyi", triageSource: "person" });
    const [state] = await db
      .select()
      .from(schema.threadState)
      .where(
        and(
          eq(schema.threadState.threadId, personal.threadId),
          eq(schema.threadState.memberId, member),
        ),
      );
    expect(state).toMatchObject({ read: true });
    expect(state!.snoozedUntil).not.toBeNull();
    const feedback = await db
      .select()
      .from(schema.triageFeedback)
      .where(eq(schema.triageFeedback.threadId, personal.threadId));
    expect(feedback).toMatchObject([{ toBucket: "fyi", memberId: member }]);
    const queued = (await actionsFor(personal.threadId)).map((a) => a.kind).sort();
    expect(queued).toEqual(["archive", "mark_read"]);
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subject, personal.threadId));
    expect(audit).toMatchObject([{ action: "mcp.triage", actorMemberId: member }]);

    // A retry queues no second archive while the mail stays where it is (a second mark_read is
    // harmless and allowed: read state must never dedupe away a later change).
    await tool(token, "triage", { changes: [change] });
    const kinds = (await actionsFor(personal.threadId)).map((a) => a.kind);
    expect(kinds.filter((k) => k === "archive")).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.triageFeedback)
        .where(eq(schema.triageFeedback.threadId, personal.threadId)),
    ).toHaveLength(1);
  });

  // Catches: read, unread, read again leaving IMAP unread because the third change reused the
  // first one's outbox key.
  test("every read change reaches IMAP, even back and forth", async () => {
    const box = await ownInbox("flip");
    const { threadId } = await seedMessage(db, box, {
      subject: "Flip flop",
      fromAddress: "a@flip.test",
      uid: 40,
    });
    for (const read of [true, false, true]) {
      await tool(token, "triage", { changes: [{ thread_id: threadId, read }] });
    }
    expect((await actionsFor(threadId)).map((a) => a.kind)).toEqual([
      "mark_read",
      "mark_unread",
      "mark_read",
    ]);
  });

  // Catches: the person's lane being replaced by the AI job of a message that arrived after
  // they chose it, because reaffirming the lane left the old message marker.
  test("reaffirming a lane after new mail moves its marker, without new feedback", async () => {
    const box = await ownInbox("lane");
    const { threadId } = await seedMessage(db, box, {
      subject: "Status report",
      fromAddress: "a@reports.test",
      uid: 50,
      sentAt: new Date("2026-10-01T00:00:00Z"),
    });
    await tool(token, "triage", { changes: [{ thread_id: threadId, lane: "fyi" }] });
    const { messageId: newer } = await seedMessage(db, box, {
      subject: "Re: Status report",
      fromAddress: "a@reports.test",
      uid: 51,
      threadId,
      sentAt: new Date("2026-10-02T00:00:00Z"),
    });
    await tool(token, "triage", { changes: [{ thread_id: threadId, lane: "fyi" }] });
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(thread).toMatchObject({ triage: "fyi", triageSource: "person", triageMessageId: newer });
    expect(
      await db
        .select()
        .from(schema.triageFeedback)
        .where(eq(schema.triageFeedback.threadId, threadId)),
    ).toHaveLength(1);
  });

  // Catches: a full batch counting as one action, so an agent could make 50x the changes the
  // limit allows (the suite runs with 60 actions a minute).
  test("each change in a batch counts toward the action limit", async () => {
    const org = await createOrg(db, "busy");
    await createMember(db, org.id, "lu@busy.test");
    const jar = new CookieJar();
    await signIn(worker, db, "lu@busy.test", jar);
    const { access_token } = await connect(jar, { scope: "openid mail:read mail:triage" });
    const batch = (n: number) =>
      tool(access_token, "triage", {
        changes: Array.from({ length: n }, () => ({ thread_id: "missing", read: true })),
      });
    expect((await batch(50)).isError).toBe(false);
    const over = await batch(11);
    expect(over.isError).toBe(true);
    expect(over.text).toContain("Too many changes");
    expect((await batch(10)).isError).toBe(false);
  });

  // Catches: helpdesk changes skipping the workflow (no event, wrong assignee), or one bad change
  // aborting the rest of the batch.
  test("triage changes a shared conversation, and one bad change fails alone", async () => {
    const { data } = await tool<{ results: { ok: boolean; error?: string }[] }>(token, "triage", {
      changes: [
        {
          thread_id: ticket,
          assignee: "me",
          priority: "high",
          add_tags: ["refunds"],
          status: "resolved",
        },
        { thread_id: ticket, add_tags: ["Nope"] },
        { thread_id: strangers, done: true },
      ],
    });
    expect(data.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(data.results[1]!.error).toContain("no tag Nope");
    expect(data.results[2]!.error).toBe("not a thread you can see");
    const [conversation] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, ticket));
    expect(conversation).toMatchObject({
      assigneeMemberId: member,
      priority: "high",
      status: "resolved",
    });
    const events = await db
      .select({ kind: schema.conversationEvents.kind })
      .from(schema.conversationEvents)
      .where(eq(schema.conversationEvents.threadId, ticket));
    expect(events.map((e) => e.kind).sort()).toEqual(
      ["assigned", "priority", "status", "tag_added"].sort(),
    );
    // Nothing was written as Jo on someone else's thread.
    const [stranger] = await db
      .select()
      .from(schema.threadState)
      .where(
        and(eq(schema.threadState.threadId, strangers), eq(schema.threadState.memberId, member)),
      );
    expect(stranger).toBeUndefined();
  });

  // Catches: a read-only grant changing mail, or a client never told which permission to ask for.
  test("writing tools ask a read-only token to step up", async () => {
    for (const [name, scope, args] of [
      ["triage", "mail:triage", { changes: [{ thread_id: personal.threadId, read: false }] }],
      ["draft_reply", "mail:draft", { thread_id: personal.threadId, body: "Hi" }],
    ] as const) {
      const response = await legacyCall(readOnly, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain(`scope="${scope}"`);
    }
  });

  // Catches: a draft addressed to ourselves, sent instead of saved, or saved on another person's
  // thread.
  test("draft_reply saves a reply for the person to send, addressed like a reply", async () => {
    const { data, isError } = await tool<{ draft_id: string; to: string[]; subject: string }>(
      token,
      "draft_reply",
      { thread_id: ticket, body: "Your refund is on its way." },
    );
    expect(isError).toBe(false);
    expect(data).toMatchObject({ to: ["buyer@shop.test"], subject: "Re: Refund please" });
    const [saved] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, data.draft_id));
    expect(saved).toMatchObject({
      kind: "reply",
      threadId: ticket,
      authorMemberId: member,
      bodyText: "Your refund is on its way.",
    });
    expect((await actionsFor(ticket)).map((a) => a.kind)).not.toContain("send");

    const elsewhere = await tool(token, "draft_reply", { thread_id: strangers, body: "Hi" });
    expect(elsewhere.isError).toBe(true);
  });
});

describe("the CRM", () => {
  interface Row {
    kind: string;
    id: string;
    name: string;
    url: string;
    workspace: string;
  }
  interface Found {
    people: (Row & { email: string | null })[];
    companies: Row[];
    deals: Row[];
  }
  interface Fetched {
    people: (Row & {
      email: string | null;
      company: Row | null;
      notes: { text: string }[];
      threads: { id: string; url: string }[];
      activity: Record<string, unknown>[];
    })[];
    companies: (Row & { contracts: { id: string; status: string }[] })[];
    not_found?: string[];
  }

  /** Another membership for `userId`, in `orgId`. */
  async function join(orgId: string, userId: string) {
    const [joined] = await db
      .insert(schema.members)
      .values({ id: crypto.randomUUID(), organizationId: orgId, userId, createdAt: new Date() })
      .returning();
    return joined!;
  }

  async function addPerson(memberId: string, name: string, address: string) {
    const added = await forMember(db, memberId).crm.addPerson({ name, address });
    if (added.status !== "ok") throw new Error(added.status);
    return added.person;
  }

  // Catches: an agent granted mail only reading or changing the company's CRM, or a client never
  // told which permission to ask for.
  test("CRM tools ask a token without crm:read or crm:write to step up", async () => {
    const org = await createOrg(db, "crmscope");
    const member = await createMember(db, org.id, "gus@crmscope.test");
    const person = await addPerson(member.id, "Ida Quinn", "ida@client.test");
    const jar = new CookieJar();
    await signIn(worker, db, "gus@crmscope.test", jar);
    const mailOnly = (await connect(jar)).access_token;
    const reader = (await connect(jar, { scope: "openid mail:read crm:read" })).access_token;

    const note = { record: { kind: "person", id: person.id }, text: "Hi" };
    const calls = [
      [mailOnly, "crm_search", "crm:read", { query: "Ida" }],
      [mailOnly, "crm_fetch", "crm:read", { records: [{ kind: "person", id: person.id }] }],
      [reader, "crm_write", "crm:write", { note }],
    ] as const;
    for (const [token, name, scope, args] of calls) {
      const response = await legacyCall(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain(`scope="${scope}"`);
    }
    const notes = await forMember(db, member.id).crm.notes({ personId: person.id });
    expect(notes.status === "ok" && notes.items).toEqual([]);

    // The scope it asked for is enough to read.
    const found = await tool<Found>(reader, "crm_search", { query: "Ida" });
    expect(found.isError).toBe(false);
    expect(found.data.people.map((p) => p.id)).toEqual([person.id]);
  });

  // Catches: a one-workspace grant reading or writing another workspace's CRM, which the consent
  // screen promised it would not reach, and a Personal-space grant failing instead of answering.
  test("a grant for one workspace sees and changes only that workspace's records", async () => {
    const work = await createOrg(db, "crmwork");
    const side = await createOrg(db, "crmside");
    const member = await createMember(db, work.id, "hal@crmwork.test");
    const sideMember = await join(side.id, member.userId);
    const atWork = await addPerson(member.id, "Pat Work", "pat@work-client.test");
    const atSide = await addPerson(sideMember.id, "Pat Side", "pat@side-client.test");

    const jar = new CookieJar();
    await signIn(worker, db, "hal@crmwork.test", jar);
    const scope = "openid mail:read crm:read crm:write";
    const everything = (await connect(jar, { scope })).access_token;
    const all = await tool<Found>(everything, "crm_search", { query: "Pat" });
    expect(all.data.people.map((p) => p.name).sort()).toEqual(["Pat Side", "Pat Work"]);

    const workOnly = (await connect(jar, { scope, workspace: work.id })).access_token;
    const found = await tool<Found>(workOnly, "crm_search", { query: "Pat" });
    expect(found.data.people).toEqual([
      expect.objectContaining({ id: atWork.id, workspace: work.id }),
    ]);
    expect(found.text).not.toContain("Pat Side");

    // No argument widens it: the other workspace's ids and name are refused by every tool.
    const fetched = await tool(workOnly, "crm_fetch", {
      records: [{ kind: "person", id: atSide.id }],
    });
    expect(fetched.isError).toBe(true);
    expect(fetched.text).not.toContain("Pat Side");
    const named = await tool(workOnly, "crm_search", { query: "Pat", workspace: side.id });
    expect(named.isError).toBe(true);
    for (const args of [
      { note: { record: { kind: "person", id: atSide.id }, text: "From the wrong grant" } },
      { person: { id: atSide.id, job_title: "Changed" } },
      { person: { name: "New Side", email: "new@side-client.test" }, workspace: side.id },
    ]) {
      expect((await tool(workOnly, "crm_write", args)).isError).toBe(true);
    }
    const sideCrm = forMember(db, sideMember.id).crm;
    const sideNotes = await sideCrm.notes({ personId: atSide.id });
    expect(sideNotes.status === "ok" && sideNotes.items).toEqual([]);
    const sidePerson = await sideCrm.person(atSide.id);
    expect(sidePerson.status === "ok" && sidePerson.person.jobTitle).toBeNull();
    const sidePeople = await sideCrm.listPeople();
    expect(sidePeople.status === "ok" && sidePeople.people.map((p) => p.name)).toEqual([
      "Pat Side",
    ]);

    // A grant for the Personal space has no CRM: a tool error, not a failure.
    const personal = await ensurePersonalSpace(db, member.userId);
    const personalOnly = (await connect(jar, { scope, workspace: personal })).access_token;
    const none = await tool(personalOnly, "crm_search", { query: "Pat" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Personal space");
  });

  // Catches: a write the agent is told succeeded but that the CRM does not hold, a fetch that
  // drops the threads the person can open with that address, a teammate's shared activity
  // missing (or carrying the thread), and `company_id: null` read as omitted, which files the
  // person under their domain's company anyway.
  test("crm_write adds a person that crm_fetch then reads, with their thread", async () => {
    const org = await createOrg(db, "crmwrite");
    const member = await createMember(db, org.id, "ivy@crmwrite.test");
    const box = await createMailbox(db, org.id, "ivy@crmwrite.test", "personal");
    await grant(db, org.id, box.id, member.id);
    const { threadId } = await seedMessage(db, box, {
      subject: "Proposal for Q3",
      fromAddress: "Lena@BigCo.test",
      to: ["ivy@crmwrite.test"],
      uid: 1,
    });
    const jar = new CookieJar();
    await signIn(worker, db, "ivy@crmwrite.test", jar);
    const { access_token } = await connect(jar, { scope: "openid mail:read crm:read crm:write" });

    const written = await tool<{ result: string; person: Row }>(access_token, "crm_write", {
      person: { name: "Lena Ortiz", email: "lena@bigco.test", job_title: "CTO" },
    });
    expect(written.isError).toBe(false);
    expect(written.data.result).toBe("added");
    const id = written.data.person.id;
    // No link until the web app serves `/crm/...`: an agent would cite a page that is not there.
    expect(written.data.person).not.toHaveProperty("url");
    // Address edits on an add are refused rather than dropped while answering "added".
    const extra = await tool(access_token, "crm_write", {
      person: { name: "Ola Ortiz", email: "ola@bigco.test", add_emails: ["ola@home.test"] },
    });
    expect(extra.isError).toBe(true);
    const noted = await tool(access_token, "crm_write", {
      note: { record: { kind: "person", id }, text: "Met at the conference." },
    });
    expect(noted.isError).toBe(false);

    const fetched = await tool<Fetched>(access_token, "crm_fetch", {
      records: [
        { kind: "person", id },
        { kind: "deal", id },
      ],
    });
    expect(fetched.isError).toBe(false);
    expect(fetched.data.people).toHaveLength(1);
    expect(fetched.data.people[0]).toMatchObject({
      id,
      name: "Lena Ortiz",
      email: "lena@bigco.test",
      workspace: org.id,
      notes: [{ text: "Met at the conference." }],
      threads: [{ id: threadId }],
    });
    expect(new URL(fetched.data.people[0]!.threads[0]!.url).pathname).toBe(`/all/${threadId}`);
    expect(fetched.data.people[0]!.company).not.toBeNull();
    expect(fetched.data.not_found).toEqual([id]);
    expect(fetched.data.people[0]!.activity).toEqual([]);

    // A teammate's mailbox shares its activity (ADR 0039 decision 2): who and when, not the thread.
    const zoe = await createMember(db, org.id, "zoe@crmwrite.test");
    const zoeBox = await createMailbox(db, org.id, "zoe@crmwrite.test", "personal");
    await db
      .insert(schema.mailboxAccess)
      .values({ orgId: org.id, mailboxId: zoeBox.id, memberId: zoe.id, role: "owner" });
    const sentAt = new Date("2026-11-12T10:00:00.000Z");
    const zoes = await seedMessage(db, zoeBox, {
      subject: "Zoe's pricing",
      fromAddress: "lena@bigco.test",
      to: ["zoe@crmwrite.test"],
      uid: 1,
      sentAt,
    });
    const set = await forMember(db, zoe.id).setCrmSharing(zoeBox.id, "activity");
    expect(set.status).toBe("ok");
    const withActivity = await tool<Fetched>(access_token, "crm_fetch", {
      records: [{ kind: "person", id }],
    });
    expect(withActivity.data.people[0]!.threads).toEqual([
      expect.objectContaining({ id: threadId }),
    ]);
    expect(withActivity.data.people[0]!.activity).toEqual([
      {
        key: expect.any(String),
        mailbox: { kind: "personal", name: "zoe@crmwrite.test" },
        last_message_at: sentAt.toISOString(),
        direction: "in",
        subject: null,
      },
    ]);
    expect(withActivity.text).not.toContain(zoes.threadId);

    // A company reads with its own contracts and none of another company's.
    const crm = forMember(db, member.id).crm;
    const companyId = fetched.data.people[0]!.company!.id;
    const other = await crm.createCompany({ name: "Elsewhere" });
    if (other.status !== "ok") throw new Error(other.status);
    const ours = await crm.createContract({ title: "MSA", companyId });
    const theirs = await crm.createContract({ title: "NDA", companyId: other.company.id });
    if (ours.status !== "ok" || theirs.status !== "ok") throw new Error("contract not made");
    const company = await tool<Fetched>(access_token, "crm_fetch", {
      records: [{ kind: "company", id: companyId }],
    });
    expect(company.data.companies[0]!.contracts).toEqual([
      expect.objectContaining({ id: ours.contract.id, status: "draft" }),
    ]);

    // An explicit null is no company, not "work it out from the domain": Lena's BigCo is there,
    // and a colleague added with company_id null stays out of it.
    const loose = await tool<{ result: string; person: Row }>(access_token, "crm_write", {
      person: { name: "Max Ortiz", email: "max@bigco.test", company_id: null },
    });
    expect(loose.isError).toBe(false);
    const max = await crm.person(loose.data.person.id);
    if (max.status !== "ok") throw new Error(max.status);
    expect(max.person.companyId).toBeNull();
  });
});

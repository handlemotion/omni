// Hardening headers on every response the deployment serves, and rate limits on the routes that
// send mail, call the mail service, or let someone guess at sign-in. Real Worker, real assets,
// real Durable Objects, real Postgres.
import { randomUUID } from "node:crypto";
import { createOrgWithOwner, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  authPost,
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

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
/** Defaults from wrangler.jsonc, as deployed. */
let worker: Awaited<ReturnType<typeof startWorker>>;
/** Tight limits, so a test can reach each one in a few calls. */
let limited: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  const base = { databaseUrl: database.url, mailServiceUrl: mailService.url };
  worker = await startWorker(base);
  limited = await startWorker({
    ...base,
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      // Per-IP auth limit off here (every test call shares one IP); its own test below.
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_MAGIC_LINK: "2/60",
      RATE_LIMIT_INVITE: "2/60",
      RATE_LIMIT_SEARCH: "2/5",
      RATE_LIMIT_SEND: "1/60",
      RATE_LIMIT_ACTIONS: "2/60",
      RATE_LIMIT_PROVISION: "1/60",
    },
  });
});

afterAll(async () => {
  await worker?.server.close();
  await limited?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function get(target: { url: string | URL }, path: string, cookie = "") {
  return fetch(new URL(path, target.url), { headers: cookie ? { cookie } : {} });
}

/** What every response carries, whoever served it. */
function expectBaseline(response: Response) {
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=63072000; includeSubDomains",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const permissions = response.headers.get("permissions-policy") ?? "";
  expect(permissions).toContain("camera=()");
  // Passkeys must stay usable on our own origin.
  expect(permissions).toContain("publickey-credentials-get=(self)");
  expect(permissions).toContain("publickey-credentials-create=(self)");
}

function csp(response: Response) {
  return new Map(
    (response.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name!, values.join(" ")]),
  );
}

describe("security headers", () => {
  test("the web app (index, deep links, built files) gets the app CSP and baseline headers", async () => {
    const index = await get(worker, "/");
    expect(index.status).toBe(200);
    const html = await index.text();
    // A deep link is index.html too (single-page app fallback) and must carry the same policy.
    const deep = await get(worker, "/inbox/some-thread");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe(html);

    for (const page of [index, deep]) {
      expectBaseline(page);
      const policy = csp(page);
      expect(policy.get("default-src")).toBe("'self'");
      // No inline or eval'd script, and nothing but our origin.
      expect(policy.get("script-src")).toBe("'self'");
      expect(policy.get("object-src")).toBe("'none'");
      expect(policy.get("base-uri")).toBe("'none'");
      expect(policy.get("frame-ancestors")).toBe("'none'");
      // The message iframe is same-origin; nothing else may be framed.
      expect(policy.get("frame-src")).toBe("'self'");
      expect(page.headers.get("referrer-policy")).toBe("same-origin");
      expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    }

    // The build references no script outside our origin, which the policy would block.
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    for (const src of scripts) {
      expect(src.startsWith("/")).toBe(true);
      const file = await get(worker, src);
      expect(file.status).toBe(200);
      expectBaseline(file);
    }
  });

  test("API answers, errors included, carry a deny-all CSP and the baseline", async () => {
    for (const path of ["/health", "/api/sign-in-methods", "/api/me", "/api/auth/get-session"]) {
      const response = await get(worker, path);
      expectBaseline(response);
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await get(worker, "/api/me")).status).toBe(401);
  });

  test("message HTML keeps its own sandboxed, frameable policy and gains the baseline", async () => {
    const { db } = database;
    const org = await createOrg(db, "headers");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    const ana = await createMember(db, org.id, "ana@headers.test");
    const box = await createMailbox(db, org.id, "ana@headers.test", "personal");
    await grant(db, org.id, box.id, ana.id);
    const { threadId, messageId } = await seedMessage(db, box, {
      subject: "Hi",
      fromAddress: "x@client.test",
      uid: 1,
    });
    const htmlR2Key = `${org.id}/${box.id}/html/${messageId}`;
    const env = await worker.server
      .getWorker<{ MAIL_BUCKET: { put(key: string, body: string): Promise<unknown> } }>()
      .getEnv();
    await env.MAIL_BUCKET.put(htmlR2Key, "<p>Hello</p>");
    await db.update(schema.messages).set({ htmlR2Key }).where(eq(schema.messages.id, messageId));
    const cookie = await signIn(worker, db, "ana@headers.test");

    const response = await get(
      worker,
      `/api/threads/${threadId}/messages/${messageId}/html`,
      cookie,
    );
    expect(response.status).toBe(200);
    expectBaseline(response);
    const policy = csp(response);
    // Scripts stay off; same origin, so its images can send the session cookie.
    expect(policy.get("sandbox")).toBe(
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    expect(policy.get("frame-ancestors")).toContain("'self'");
    expect(policy.get("img-src")).toBe("'self' data:");
  });
});

describe("rate limits", () => {
  async function outboxTo(email: string) {
    const rows = await database.db
      .select({ payload: schema.mailActions.payload })
      .from(schema.mailActions)
      .where(eq(schema.mailActions.kind, "send"));
    return rows.filter((r) => (r.payload as { to: string[] }).to[0]!.toLowerCase() === email);
  }

  function requestMagicLink(email: string) {
    return fetch(new URL("/api/auth/sign-in/magic-link", limited.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      // Spelled differently each time: the limit is per address, not per string.
      body: JSON.stringify({ email, callbackURL: "/" }),
    });
  }

  test("magic links are limited per address, so nobody can mail-bomb an inbox", async () => {
    const { db } = database;
    const org = await createOrg(db, "bomb");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    await createMember(db, org.id, "victim@bomb.test");
    await createMember(db, org.id, "other@bomb.test");

    expect((await requestMagicLink("victim@bomb.test")).status).toBe(200);
    expect((await requestMagicLink("Victim@Bomb.test")).status).toBe(200);
    const refused = await requestMagicLink("VICTIM@bomb.test");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expectBaseline(refused);
    expect(await outboxTo("victim@bomb.test")).toHaveLength(2);

    // Someone else's address is unaffected.
    expect((await requestMagicLink("other@bomb.test")).status).toBe(200);
    expect(await outboxTo("other@bomb.test")).toHaveLength(1);
  });

  test("sign-in steps are limited per IP; session reads are not", async () => {
    const tight = await startWorker({
      databaseUrl: database.url,
      mailServiceUrl: mailService.url,
      vars: { RATE_LIMIT_AUTH: "3/60" },
    });
    try {
      const passkeyOptions = () => get(tight, "/api/auth/passkey/generate-authenticate-options");
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await passkeyOptions()).status);
      expect(statuses).toEqual([200, 200, 200]);
      // Every sign-in method shares the budget: passkey, magic link, Google.
      expect((await passkeyOptions()).status).toBe(429);
      const google = await authPost(tight, new CookieJar(), "/sign-in/social", {
        provider: "google",
      });
      expect(google.status).toBe(429);
      const verify = await get(tight, "/api/auth/magic-link/verify?token=guess");
      expect(verify.status).toBe(429);
      // The app polls the session; that never counts.
      for (let i = 0; i < 5; i++) {
        expect((await get(tight, "/api/auth/get-session")).status).toBe(200);
      }
    } finally {
      await tight.server.close();
    }
  });

  test("invitations, each of which sends mail, are limited per inviting user", async () => {
    const { db } = database;
    const slug = `inv-${randomUUID().slice(0, 8)}`;
    const owner = await createOrgWithOwner(db, { name: slug, slug, ownerEmail: `o@${slug}.test` });
    await createMailbox(db, owner.orgId, SYSTEM_MAIL_FROM);
    const jar = new CookieJar();
    await signIn(limited, db, `o@${slug}.test`, jar);

    const invite = (n: number) =>
      authPost(limited, jar, "/organization/invite-member", {
        email: `guest${n}@${slug}.test`,
        role: "member",
      });
    expect((await invite(1)).status).toBe(200);
    expect((await invite(2)).status).toBe(200);
    expect((await invite(3)).status).toBe(429);
    const invitations = await db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.organizationId, owner.orgId));
    expect(invitations.map((i) => i.email).sort()).toEqual([
      `guest1@${slug}.test`,
      `guest2@${slug}.test`,
    ]);
  });

  test("search, sending and outbox writes are limited per member, and a window resets", async () => {
    const { db } = database;
    const org = await createOrg(db, "busy");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    const ana = await createMember(db, org.id, "ana@busy.test");
    await createMember(db, org.id, "bea@busy.test");
    const box = await createMailbox(db, org.id, "ana@busy.test", "personal");
    await grant(db, org.id, box.id, ana.id);
    const { threadId } = await seedMessage(db, box, {
      subject: "Hi",
      fromAddress: "x@client.test",
      uid: 1,
    });
    const anaCookie = await signIn(limited, db, "ana@busy.test");
    const beaCookie = await signIn(limited, db, "bea@busy.test");

    const search = (cookie: string) => get(limited, "/api/search?q=hi", cookie);
    expect((await search(anaCookie)).status).toBe(200);
    expect((await search(anaCookie)).status).toBe(200);
    const refused = await search(anaCookie);
    expect(refused.status).toBe(429);
    // Another member has their own budget.
    expect((await search(beaCookie)).status).toBe(200);
    // Once the window passes, the member gets in again.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    expect((await search(anaCookie)).status).toBe(200);

    const post = (path: string, body: unknown, method: "POST" | "PATCH" = "POST") =>
      fetch(new URL(`/api${path}`, limited.url), {
        method,
        headers: {
          cookie: anaCookie,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(body),
      });
    const send = { mailboxId: box.id, to: ["x@client.test"], subject: "s", text: "t" };
    expect((await post("/send", send)).status).toBe(202);
    expect((await post("/send", send)).status).toBe(429);
    expect((await post(`/threads/${threadId}/reply`, { text: "r" })).status).toBe(429);
    const sends = await db
      .select()
      .from(schema.mailActions)
      .where(and(eq(schema.mailActions.memberId, ana.id), eq(schema.mailActions.kind, "send")));
    expect(sends).toHaveLength(1);

    const state = () => post(`/threads/${threadId}/state`, { read: true }, "PATCH");
    expect((await state()).status).toBe(200);
    expect((await state()).status).toBe(200);
    expect((await state()).status).toBe(429);
  });

  test("onboarding calls to the mail service are limited per member", async () => {
    const { db } = database;
    const slug = `prov-${randomUUID().slice(0, 8)}`;
    await createOrgWithOwner(db, { name: slug, slug, ownerEmail: `o@${slug}.test` });
    const cookie = await signIn(limited, db, `o@${slug}.test`);
    const before = mailService.requests.filter((r) => r.path.startsWith("/provision")).length;

    const addDomain = () =>
      fetch(new URL("/api/onboarding/domains", limited.url), {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ domain: `${slug}.test` }),
      });
    // The stand-in mail service answers nothing useful, so the first call fails upstream (502);
    // it still counted, and the second never reaches the mail service.
    expect((await addDomain()).status).toBe(502);
    expect((await addDomain()).status).toBe(429);
    const after = mailService.requests.filter((r) => r.path.startsWith("/provision")).length;
    expect(after - before).toBe(1);
  });
});

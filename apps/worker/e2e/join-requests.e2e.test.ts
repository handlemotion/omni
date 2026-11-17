import { randomUUID } from "node:crypto";
import { createOrgWithOwner, schema } from "@omni/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  CookieJar,
  createMailbox,
  createOrg,
  createTestDatabase,
  sentMail,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { WEB_APP_URL: WEB_ORIGIN, SYSTEM_MAIL_FROM },
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

interface Answer {
  company?: { id: string; name: string };
  requested?: boolean;
  requests?: { id: string; user: { email: string } }[];
}

async function call(jar: CookieJar, method: "GET" | "POST", path: string) {
  const response = await fetch(new URL(`/api${path}`, worker.url), {
    method,
    headers: { cookie: jar.header, origin: WEB_ORIGIN, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Answer };
}

async function company(name: string, domain: string) {
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@owners.test`;
  const org = await createOrgWithOwner(database.db, {
    name,
    slug: `${name.toLowerCase().replaceAll(" ", "-")}-${randomUUID().slice(0, 8)}`,
    ownerEmail,
  });
  await database.db
    .insert(schema.mailDomains)
    .values({ orgId: org.orgId, domain, provider: "imap" });
  const jar = new CookieJar();
  await signIn(worker, database.db, ownerEmail, jar);
  return { ...org, ownerEmail, jar };
}

async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(worker, database.db, email, jar);
  return jar;
}

test("someone outside the company asks to join; only its owners hear and decide", async () => {
  const tag = randomUUID().slice(0, 8);
  const acme = await company("Acme", `acme-${tag}.test`);
  const other = await company("Other", `other-${tag}.test`);
  const ana = await signedIn(`ana@acme-${tag}.test`);

  expect((await call(ana, "GET", "/me")).status).toBe(403);
  expect((await call(ana, "GET", "/join")).body).toEqual({
    company: { id: acme.orgId, name: "Acme" },
    requested: false,
  });

  expect((await call(ana, "POST", "/join")).body).toMatchObject({ requested: true });
  expect((await call(ana, "POST", "/join")).body).toMatchObject({ requested: true });
  await expect
    .poll(async () =>
      (await sentMail(worker, acme.ownerEmail)).filter((m) => m.subject.includes("asked to join")),
    )
    .toHaveLength(1);
  expect((await call(ana, "GET", "/join")).body).toMatchObject({ requested: true });

  const listed = await call(acme.jar, "GET", "/join/requests");
  expect(listed.body.requests).toEqual([
    expect.objectContaining({ user: expect.objectContaining({ email: `ana@acme-${tag}.test` }) }),
  ]);
  const requestId = listed.body.requests![0]!.id;

  expect((await call(ana, "POST", `/join/requests/${requestId}/accept`)).status).toBe(403);
  expect((await call(other.jar, "GET", "/join/requests")).body).toEqual({ requests: [] });
  expect((await call(other.jar, "POST", `/join/requests/${requestId}/accept`)).status).toBe(404);

  expect((await call(acme.jar, "POST", `/join/requests/${requestId}/accept`)).status).toBe(204);
  expect((await call(ana, "GET", "/me")).body).toMatchObject({ orgId: acme.orgId, role: "member" });
  expect((await call(ana, "GET", "/join")).status).toBe(404);
  expect((await call(acme.jar, "GET", "/join/requests")).body).toEqual({ requests: [] });
});

test("a declined request is gone and can be made again; an unscoped sign-in has nothing to join", async () => {
  const tag = randomUUID().slice(0, 8);
  const acme = await company("Decline Co", `decline-${tag}.test`);
  const bo = await signedIn(`bo@decline-${tag}.test`);
  await call(bo, "POST", "/join");
  const [request] = (await call(acme.jar, "GET", "/join/requests")).body.requests!;
  expect((await call(acme.jar, "POST", `/join/requests/${request!.id}/decline`)).status).toBe(204);
  expect((await call(bo, "GET", "/me")).status).toBe(403);
  expect((await call(bo, "GET", "/join")).body).toMatchObject({ requested: false });
  expect((await call(bo, "POST", "/join")).body).toMatchObject({ requested: true });

  const free = await signedIn(`free-${tag}@gmail.test`);
  expect((await call(free, "GET", "/join")).status).toBe(404);
});

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMember,
  createOrg,
  createTestDatabase,
  sentMail,
  startMailServiceEndpoint,
  startWorker,
  WEB_ORIGIN,
} from "./support.ts";

const APP_ORIGIN = "omni://";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { AUTH_TRUSTED_ORIGINS: `${WEB_ORIGIN},${APP_ORIGIN}` },
  });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function requestLink(email: string, callbackURL: string) {
  return fetch(new URL("/api/auth/sign-in/magic-link", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", "expo-origin": APP_ORIGIN },
    body: JSON.stringify({ email, callbackURL }),
  });
}

async function openLink(email: string) {
  const link = (await sentMail(worker, email)).at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  expect(link).toBeDefined();
  const url = new URL(link!);
  return fetch(new URL(url.pathname + url.search, worker.url), { redirect: "manual" });
}

function cookieHeader(setCookie: string) {
  return [...setCookie.matchAll(/(?:^|,\s*)((?:__Secure-)?better-auth\.[\w.]+)=([^;]*)/g)]
    .map(([, name, value]) => `${name}=${value}`)
    .join("; ");
}

test("a magic link opened on the phone hands the app a session it can call the API with", async () => {
  const { db } = database;
  const org = await createOrg(db, "ios");
  const member = await createMember(db, org.id, "ana@ios.test");

  expect((await requestLink("ana@ios.test", `${APP_ORIGIN}/`)).status).toBe(200);
  const verified = await openLink("ana@ios.test");
  expect(verified.status).toBe(302);

  const location = new URL(verified.headers.get("location")!);
  expect(location.protocol).toBe("omni:");
  const setCookie = location.searchParams.get("cookie");
  expect(setCookie).toContain("session_token");

  const me = await fetch(new URL("/api/me", worker.url), {
    headers: { cookie: cookieHeader(setCookie!) },
  });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: member.id, orgId: org.id });
});

test("a link that ends on an untrusted app scheme never carries a session", async () => {
  const { db } = database;
  const org = await createOrg(db, "evil");
  await createMember(db, org.id, "ben@evil.test");

  const requested = await requestLink("ben@evil.test", "evil://steal");
  expect(requested.status).toBe(403);
  expect(await sentMail(worker, "ben@evil.test")).toEqual([]);
});

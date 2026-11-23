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

function cookieHeader(setCookie: string[]) {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

test("native email OTP on iOS returns a session cookie directly without a browser redirect", async () => {
  const { db } = database;
  const org = await createOrg(db, "ios");
  const member = await createMember(db, org.id, "ana@ios.test");

  const requested = await fetch(new URL("/api/auth/email-otp/send-verification-otp", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", "expo-origin": APP_ORIGIN },
    body: JSON.stringify({ email: "ana@ios.test", type: "sign-in" }),
  });
  expect(requested.status).toBe(200);

  const otp = (await sentMail(worker, "ana@ios.test")).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  expect(otp).toBeDefined();

  const verified = await fetch(new URL("/api/auth/sign-in/email-otp", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", "expo-origin": APP_ORIGIN },
    body: JSON.stringify({ email: "ana@ios.test", otp }),
  });
  expect(verified.status).toBe(200);

  const cookie = cookieHeader(verified.headers.getSetCookie());
  expect(cookie).toContain("session_token");

  const me = await fetch(new URL("/api/me", worker.url), { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: member.id, orgId: org.id });
});

test("magic link endpoints are removed and sign-in-methods reports google and apple", async () => {
  const magic = await fetch(new URL("/api/auth/sign-in/magic-link", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", "expo-origin": APP_ORIGIN },
    body: JSON.stringify({ email: "ana@ios.test" }),
  });
  expect(magic.status).toBe(404);

  const methods = await fetch(new URL("/api/sign-in-methods", worker.url));
  expect(methods.status).toBe(200);
  expect(await methods.json()).toEqual({ google: false, apple: false });
});

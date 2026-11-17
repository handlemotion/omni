import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authPost,
  CookieJar,
  createTestDatabase,
  startMailServiceEndpoint,
  startWorker,
  WEB_ORIGIN,
} from "./support.ts";

const GOOGLE_CLIENT_ID = "e2e-client.apps.googleusercontent.com";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let withGoogle: Awaited<ReturnType<typeof startWorker>>;
let withoutGoogle: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  const base = { databaseUrl: database.url, mailServiceUrl: mailService.url };
  withGoogle = await startWorker({
    ...base,
    vars: {
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
      AUTH_TRUSTED_ORIGINS: `${WEB_ORIGIN},omni://`,
    },
  });
  withoutGoogle = await startWorker(base);
});

afterAll(async () => {
  await withGoogle?.server.close();
  await withoutGoogle?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function methods(worker: { url: string | URL }) {
  return fetch(new URL("/api/sign-in-methods", worker.url)).then((r) => r.json());
}

test("with no Google client configured, the login page hides Google and auth refuses it", async () => {
  expect(await methods(withoutGoogle)).toEqual({ google: false });

  const started = await authPost(withoutGoogle, new CookieJar(), "/sign-in/social", {
    provider: "google",
    callbackURL: "/inbox",
  });
  expect(started.status).toBe(404);
});

test("Google sign-in sends the browser to Google and a cancelled consent lands on /login", async () => {
  expect(await methods(withGoogle)).toEqual({ google: true });

  const jar = new CookieJar();
  const started = await authPost(withGoogle, jar, "/sign-in/social", {
    provider: "google",
    callbackURL: "/inbox",
    errorCallbackURL: "/login",
  });
  expect(started.status).toBe(200);
  const { url, redirect } = (await started.json()) as { url: string; redirect: boolean };
  expect(redirect).toBe(true);

  const authorize = new URL(url);
  expect(authorize.origin).toBe("https://accounts.google.com");
  expect(authorize.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "http://localhost:8787/api/auth/callback/google",
  );
  expect(authorize.searchParams.get("prompt")).toBe("select_account");
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();

  const back = await fetch(
    new URL(`/api/auth/callback/google?error=access_denied&state=${state}`, withGoogle.url),
    { redirect: "manual", headers: { cookie: jar.header } },
  );
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.get("location") ?? "", WEB_ORIGIN);
  expect(landing.pathname).toBe("/login");
  expect(landing.searchParams.get("error")).toBe("access_denied");
});

test("desktop Google sign-in runs in the browser and returns to the app's omni:// callback", async () => {
  const callbackURL = "omni://auth?state=desktop-state";
  const started = await authPost(withGoogle, new CookieJar(), "/sign-in/social", {
    provider: "google",
    callbackURL,
    errorCallbackURL: callbackURL,
    disableRedirect: true,
  });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");

  const browser = new CookieJar();
  const proxy = new URL("/api/auth/expo-authorization-proxy", withGoogle.url);
  proxy.searchParams.set("authorizationURL", url);
  const toGoogle = browser.store(await fetch(proxy, { redirect: "manual" }));
  expect(toGoogle.status).toBe(302);
  expect(toGoogle.headers.get("location")).toBe(url);

  const back = await fetch(
    new URL(`/api/auth/callback/google?error=access_denied&state=${state}`, withGoogle.url),
    { redirect: "manual", headers: { cookie: browser.header } },
  );
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.get("location") ?? "");
  expect(`${landing.protocol}//${landing.host}`).toBe("omni://auth");
  expect(landing.searchParams.get("state")).toBe("desktop-state");
  expect(landing.searchParams.get("error")).toBe("access_denied");
});

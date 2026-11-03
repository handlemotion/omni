// Google sign-in up to Google's door and back. The code exchange needs Google itself, so it is
// not covered here; everything on our side of it is.
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
    vars: { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: "e2e-google-client-secret" },
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
  // Signed out: the login page has to be able to ask.
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
  // Must match the redirect URI registered with Google, or Google refuses the request.
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "http://localhost:8787/api/auth/callback/google",
  );
  expect(authorize.searchParams.get("prompt")).toBe("select_account");
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();

  // The user cancels on Google's screen: Google returns with `error` and our state.
  const back = await fetch(
    new URL(`/api/auth/callback/google?error=access_denied&state=${state}`, withGoogle.url),
    { redirect: "manual", headers: { cookie: jar.header } },
  );
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.get("location") ?? "", WEB_ORIGIN);
  expect(landing.pathname).toBe("/login");
  expect(landing.searchParams.get("error")).toBe("access_denied");
});

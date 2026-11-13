// Connecting a Gmail account over the real Worker: the consent redirect carries PKCE and a state
// bound to this browser and member, and only a matching callback reaches the mail service, signed,
// with the code and the verifier. The Worker never sees a Google token.
import { schema } from "@omni/db";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

const CLIENT_ID = "e2e-client.apps.googleusercontent.com";
const REDIRECT_URI = "http://localhost:8787/api/connect/google/callback";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint(async ({ path, body }) => {
    if (path === "/connect/google/disconnect") {
      return {
        status: 200,
        json: { mailboxId: (JSON.parse(body) as { mailboxId: string }).mailboxId },
      };
    }
    const { code, orgId, memberId } = JSON.parse(body) as Record<string, string>;
    if (code === "saving-code") {
      // As the real mail service does: the Gmail mailbox exists before the Worker hears back.
      const mailbox = await createMailbox(database.db, orgId!, `${orgId}@gmail.com`, "personal");
      await grant(database.db, orgId!, mailbox.id, memberId!);
      return {
        status: 200,
        json: { mailboxId: mailbox.id, address: mailbox.address, created: true },
      };
    }
    if (code === "taken-code") {
      return { status: 409, json: { error: "That Google account is connected elsewhere." } };
    }
    return {
      status: 200,
      json: { mailboxId: "mbx_connected", address: "ana@gmail.com", created: true },
    };
  });
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { GOOGLE_CLIENT_ID: CLIENT_ID, WEB_APP_URL: WEB_ORIGIN },
    secrets: { GOOGLE_CLIENT_SECRET: "e2e-google-secret" },
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    redirect: "manual",
    headers: { cookie, origin: WEB_ORIGIN },
  });
}

/** Starts the flow: Google's consent URL and the flow cookie the browser now holds. */
async function start(session: string, from?: "onboarding") {
  const response = await api(`/connect/google/start${from ? `?return=${from}` : ""}`, session);
  expect(response.status).toBe(302);
  const consent = new URL(response.headers.get("location")!);
  const flow = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("omni_google_connect="));
  expect(flow).toBeDefined();
  return { consent, flow: flow! };
}

async function callback(cookie: string, query: Record<string, string>) {
  const response = await api(`/connect/google/callback?${new URLSearchParams(query)}`, cookie);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

async function signedInMember(email: string) {
  const org = await createOrg(database.db, email.split("@")[0]!);
  const member = await createMember(database.db, org.id, email);
  return { org, member, session: await signIn(worker, database.db, email) };
}

describe("connecting a Google account", () => {
  test("only the browser and member that started it reach the mail service, with the PKCE verifier", async () => {
    const ana = await signedInMember("ana@connect.test");
    const { consent, flow } = await start(ana.session);
    expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = consent.searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("scope")).toBe("https://mail.google.com/ openid email");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("code_challenge_method")).toBe("S256");
    const state = params.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(32);

    const before = mailService.requests.length;
    // A forged callback without the flow cookie, and one with a different state, go nowhere.
    expect((await callback(ana.session, { code: "c-1", state })).searchParams.get("reason")).toBe(
      "expired",
    );
    const withFlow = `${ana.session}; ${flow}`;
    expect(
      (await callback(withFlow, { code: "c-1", state: `${state}x` })).searchParams.get("reason"),
    ).toBe("expired");
    // Another member's session holding Ana's flow cookie can't finish her flow.
    const bob = await signedInMember("bob@connect.test");
    expect(
      (await callback(`${bob.session}; ${flow}`, { code: "c-1", state })).searchParams.get(
        "reason",
      ),
    ).toBe("expired");
    expect(mailService.requests.length).toBe(before);

    const landed = await callback(withFlow, { code: "google-code", state });
    expect(landed.origin + landed.pathname).toBe(`${WEB_ORIGIN}/settings/accounts`);
    expect(Object.fromEntries(landed.searchParams)).toEqual({
      google: "connected",
      mailboxId: "mbx_connected",
    });
    const [sent] = (await mailService.waitFor(before + 1)).slice(before);
    expect(sent!.path).toBe("/connect/google");
    expect(sent!.verified.ok).toBe(true);
    const body = JSON.parse(sent!.body) as Record<string, string>;
    expect(body).toMatchObject({
      orgId: ana.org.id,
      memberId: ana.member.id,
      code: "google-code",
      redirectUri: REDIRECT_URI,
    });
    // The verifier is the one behind the challenge Google saw, so Google accepts the exchange.
    expect(createHash("sha256").update(body.codeVerifier!).digest("base64url")).toBe(
      params.get("code_challenge"),
    );
  });

  test("a kept flow cookie cannot be replayed into unlimited mail service calls", async () => {
    // RATE_LIMIT_PROVISION is 30 an hour per member, shared with /start.
    const mallory = await signedInMember("replay@connect.test");
    const { consent, flow } = await start(mallory.session);
    const state = consent.searchParams.get("state")!;
    const before = mailService.requests.length;
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const response = await api(
        `/connect/google/callback?${new URLSearchParams({ code: `guess-${i}`, state })}`,
        `${mallory.session}; ${flow}`,
      );
      await response.body?.cancel();
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(mailService.requests.length - before).toBeLessThan(30);
  });

  test("a denied consent and an account in use come back as reasons, not errors", async () => {
    const cara = await signedInMember("cara@connect.test");
    const first = await start(cara.session);
    const denied = await callback(`${cara.session}; ${first.flow}`, {
      error: "access_denied",
      state: first.consent.searchParams.get("state")!,
    });
    expect(denied.searchParams.get("reason")).toBe("denied");

    const second = await start(cara.session);
    const taken = await callback(`${cara.session}; ${second.flow}`, {
      code: "taken-code",
      state: second.consent.searchParams.get("state")!,
    });
    expect(Object.fromEntries(taken.searchParams)).toEqual({ google: "error", reason: "in_use" });
  });

  test("started in setup, it returns to setup, and only a connected account lets setup finish", async () => {
    const dee = await signedInMember("dee@connect.test");
    // Setting up a workspace is its owner's job.
    await database.db
      .update(schema.members)
      .set({ role: "owner" })
      .where(eq(schema.members.id, dee.member.id));
    const setup = async () =>
      (
        (await (await api("/onboarding", dee.session)).json()) as {
          organization: { setup: string };
        }
      ).organization.setup;

    const first = await start(dee.session, "onboarding");
    const taken = await callback(`${dee.session}; ${first.flow}`, {
      code: "taken-code",
      state: first.consent.searchParams.get("state")!,
    });
    expect(taken.origin + taken.pathname).toBe(`${WEB_ORIGIN}/onboarding`);
    expect(taken.searchParams.get("reason")).toBe("in_use");
    expect(await setup()).toBe("created");
    expect((await api("/onboarding/complete", dee.session, { method: "POST" })).status).toBe(409);

    const second = await start(dee.session, "onboarding");
    const landed = await callback(`${dee.session}; ${second.flow}`, {
      code: "saving-code",
      state: second.consent.searchParams.get("state")!,
    });
    expect(landed.origin + landed.pathname).toBe(`${WEB_ORIGIN}/onboarding`);
    expect(landed.searchParams.get("google")).toBe("connected");
    // Still in setup (invitations and the plan come next), not taken for a finished workspace.
    expect(await setup()).toBe("mailboxes_created");
    expect((await api("/onboarding/complete", dee.session, { method: "POST" })).status).toBe(200);
  });
});

describe("disconnecting a Google account", () => {
  test("only the member's own Gmail inbox, through the mail service", async () => {
    const dan = await signedInMember("dan@connect.test");
    const gmail = await createMailbox(database.db, dan.org.id, "dan@gmail.com", "personal");
    await database.db
      .update(schema.mailboxes)
      .set({ provider: "gmail" })
      .where(eq(schema.mailboxes.id, gmail.id));
    await grant(database.db, dan.org.id, gmail.id, dan.member.id);
    const shared = await createMailbox(database.db, dan.org.id, "help@dan.test");
    await grant(database.db, dan.org.id, shared.id, dan.member.id);

    const listed = await (await api("/connect/google", dan.session)).json();
    expect(listed).toEqual({
      available: true,
      accounts: [{ mailboxId: gmail.id, address: "dan@gmail.com", status: "active" }],
    });

    const before = mailService.requests.length;
    expect(
      (await api(`/connect/google/${shared.id}`, dan.session, { method: "DELETE" })).status,
    ).toBe(404);
    const eve = await signedInMember("eve@connect.test");
    expect(
      (await api(`/connect/google/${gmail.id}`, eve.session, { method: "DELETE" })).status,
    ).toBe(404);
    expect(mailService.requests.length).toBe(before);

    expect(
      (await api(`/connect/google/${gmail.id}`, dan.session, { method: "DELETE" })).status,
    ).toBe(204);
    const [sent] = (await mailService.waitFor(before + 1)).slice(before);
    expect(sent!.path).toBe("/connect/google/disconnect");
    expect(sent!.verified.ok).toBe(true);
    expect(JSON.parse(sent!.body)).toEqual({
      orgId: dan.org.id,
      memberId: dan.member.id,
      mailboxId: gmail.id,
    });
  });
});

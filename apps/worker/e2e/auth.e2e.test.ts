import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
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
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

test("a magic link from the outbox signs the member in, and the outbox ping verifies", async () => {
  const { db } = database;
  const org = await createOrg(db, "acme");
  const system = await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const member = await createMember(db, org.id, "ana@acme.test");

  const anonymous = await fetch(new URL("/api/me", worker.url));
  expect(anonymous.status).toBe(401);

  const requested = await fetch(new URL("/api/auth/sign-in/magic-link", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: "ana@acme.test", callbackURL: "/" }),
  });
  expect(requested.status).toBe(200);

  // The link goes out as an ordinary send from the system mailbox.
  const actions = await db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, system.id));
  expect(actions).toHaveLength(1);
  const [action] = actions;
  expect(action!.kind).toBe("send");
  expect(action!.memberId).toBeNull();
  const payload = action!.payload as { from: string; to: string[]; text: string };
  expect(payload.from).toBe(SYSTEM_MAIL_FROM);
  expect(payload.to).toEqual(["ana@acme.test"]);

  // The mail service was told, with a signature its verifier accepts.
  const [ping] = await mailService.waitFor(1);
  expect(ping!.method).toBe("POST");
  expect(ping!.path).toBe("/ping");
  expect(ping!.verified.ok).toBe(true);

  const link = new URL(payload.text.match(/https?:\/\/\S+/)![0]);
  const verified = await fetch(new URL(link.pathname + link.search, worker.url), {
    redirect: "manual",
  });
  expect(verified.status).toBe(302);
  const cookie = verified.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token");

  const me = await fetch(new URL("/api/me", worker.url), { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: member.id, orgId: org.id });

  // A link works once.
  const reused = await fetch(new URL(link.pathname + link.search, worker.url), {
    redirect: "manual",
  });
  expect(reused.headers.getSetCookie().filter((c) => /session_token=[^;]/.test(c))).toEqual([]);
});

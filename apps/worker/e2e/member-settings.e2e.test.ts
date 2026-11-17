import { addLocation, schema, upsertFolder } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
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
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function api(path: string, cookie: string, init: RequestInit & { key?: string } = {}) {
  const { key, ...rest } = init;
  return fetch(new URL(`/api${path}`, worker.url), {
    ...rest,
    headers: {
      cookie,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
  });
}

async function person(slug: string, name: string) {
  const { db } = database;
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.name, slug));
  const owner = org ?? (await createOrg(db, slug));
  const member = await createMember(db, owner.id, `${name}@${slug}.test`);
  return { org: owner, member, cookie: await signIn(worker, db, `${name}@${slug}.test`) };
}

describe("preferences", () => {
  test("defaults read back filled in; a change merges channel by channel and sets the undo window", async () => {
    const { cookie } = await person("prefs", "ana");
    const initial = await (await api("/preferences", cookie)).json();
    expect(initial).toMatchObject({
      theme: "system",
      undoSendSeconds: 5,
      notifications: { mention: { realtime: true, desktop: true, push: true } },
    });

    await api("/preferences", cookie, {
      method: "PATCH",
      body: JSON.stringify({ notifications: { mention: { desktop: false } }, theme: "dark" }),
    });
    const after = await (
      await api("/preferences", cookie, {
        method: "PATCH",
        body: JSON.stringify({ notifications: { mention: { push: false } }, undoSendSeconds: 10 }),
      })
    ).json();
    expect(after).toMatchObject({
      theme: "dark",
      undoSendSeconds: 10,
      notifications: {
        mention: { realtime: true, desktop: false, push: false },
        assigned: { realtime: true, desktop: true, push: true },
      },
    });
    const tooLong = await api("/preferences", cookie, {
      method: "PATCH",
      body: JSON.stringify({ undoSendSeconds: 600 }),
    });
    expect(tooLong.status).toBe(400);

    const patches = [
      { theme: "light" },
      { undoSendSeconds: 20 },
      { notifications: { assigned: { push: false } } },
      { notifications: { customer_reply: { desktop: false } } },
      { notifications: { mention: { realtime: false } } },
    ];
    await Promise.all(
      patches.map((patch) =>
        api("/preferences", cookie, { method: "PATCH", body: JSON.stringify(patch) }),
      ),
    );
    expect(await (await api("/preferences", cookie)).json()).toMatchObject({
      theme: "light",
      undoSendSeconds: 20,
      notifications: {
        assigned: { realtime: true, desktop: true, push: false },
        customer_reply: { realtime: true, desktop: false, push: true },
        mention: { realtime: false, desktop: false, push: false },
      },
    });
  });
});

describe("push tokens", () => {
  test("a phone's token follows whoever signed in last, and only its owner removes it", async () => {
    const { db } = database;
    const ana = await person("phones", "ana");
    const bea = await person("phones", "bea");
    const token = "ExponentPushToken[abc123]";
    const register = (cookie: string) =>
      api("/push-tokens", cookie, {
        method: "POST",
        body: JSON.stringify({ expoToken: token, device: "iPhone" }),
      });

    expect((await register(ana.cookie)).status).toBe(204);
    expect((await register(bea.cookie)).status).toBe(204);
    const rows = await db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.expoToken, token));
    expect(rows.map((r) => r.memberId)).toEqual([bea.member.id]);

    const path = `/push-tokens/${encodeURIComponent(token)}`;
    expect((await api(path, ana.cookie, { method: "DELETE" })).status).toBe(404);
    expect((await api(path, bea.cookie, { method: "DELETE" })).status).toBe(204);
    expect(
      await db.select().from(schema.pushTokens).where(eq(schema.pushTokens.expoToken, token)),
    ).toEqual([]);

    const bogus = await api("/push-tokens", ana.cookie, {
      method: "POST",
      body: JSON.stringify({ expoToken: "not-a-token" }),
    });
    expect(bogus.status).toBe(400);
  });
});

describe("trash and spam", () => {
  test("each moves the right IMAP copies and takes the conversation out of (or back into) the inbox", async () => {
    const { db } = database;
    const org = await createOrg(db, "junk");
    const inbox = await createMailbox(db, org.id, "support@junk.test");
    const ana = await createMember(db, org.id, "ana@junk.test");
    await grant(db, org.id, inbox.id, ana.id);
    const cookie = await signIn(worker, db, "ana@junk.test");
    const { threadId, messageId } = await seedMessage(db, inbox, {
      subject: "You won",
      fromAddress: "prize@spam.test",
      uid: 7,
    });
    const junk = await upsertFolder(db, {
      orgId: org.id,
      mailboxId: inbox.id,
      path: "Junk",
      role: "junk",
      uidvalidity: 5,
      uidnext: 100,
      highestModseq: null,
    });

    const act = async (route: string, key: string) => {
      const response = await api(`/threads/${threadId}/${route}`, cookie, { method: "POST", key });
      expect(response.status).toBe(200);
      const { actionIds } = (await response.json()) as { actionIds: string[] };
      return Promise.all(
        actionIds.map(async (id) => {
          const [row] = await db
            .select()
            .from(schema.mailActions)
            .where(eq(schema.mailActions.id, id));
          return { kind: row!.kind, payload: row!.payload };
        }),
      );
    };
    const archived = async () =>
      (await db.select().from(schema.threads).where(eq(schema.threads.id, threadId)))[0]!.archived;

    expect(await act("spam", "spam-key-1")).toEqual([
      { kind: "spam", payload: { folder: "INBOX", uidValidity: "1700000000", uids: [7] } },
    ]);
    expect(await archived()).toBe(true);

    await db
      .delete(schema.messageLocations)
      .where(eq(schema.messageLocations.messageId, messageId));
    await addLocation(db, {
      orgId: org.id,
      mailboxId: inbox.id,
      folderId: junk.id,
      uid: 3,
      messageId,
      flags: [],
      modseq: null,
    });
    expect(await act("not-spam", "not-spam-key-1")).toEqual([
      { kind: "not_spam", payload: { folder: "Junk", uidValidity: "5", uids: [3] } },
    ]);
    expect(await archived()).toBe(false);
    expect(await act("trash", "trash-key-1")).toEqual([
      { kind: "trash", payload: { folder: "Junk", uidValidity: "5", uids: [3] } },
    ]);
    expect(await archived()).toBe(true);

    const outsider = await createMember(db, org.id, "cy@junk.test");
    expect(outsider).toBeDefined();
    const cy = await signIn(worker, db, "cy@junk.test");
    const denied = await api(`/threads/${threadId}/trash`, cy, {
      method: "POST",
      key: "cy-trash-1",
    });
    expect(denied.status).toBe(404);
  });
});

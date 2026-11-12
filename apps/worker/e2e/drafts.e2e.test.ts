// Shared drafts and undo send over the real Worker and Postgres: autosave that never overwrites a
// teammate, sending a draft, and cancelling a send inside its window.
import { schema } from "@omni/db";
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
      ...rest.headers,
    },
  });
}

const json = (method: string, body: unknown, key?: string) => ({
  method,
  body: JSON.stringify(body),
  ...(key ? { key } : {}),
});

async function team(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  const inbox = await createMailbox(db, org.id, `support@${slug}.test`);
  const people = {} as Record<"ana" | "bea" | "cy", { id: string; cookie: string }>;
  for (const name of ["ana", "bea", "cy"] as const) {
    const email = `${name}@${slug}.test`;
    const member = await createMember(db, org.id, email);
    if (name !== "cy") await grant(db, org.id, inbox.id, member.id);
    people[name] = { id: member.id, cookie: await signIn(worker, db, email) };
  }
  const thread = await seedMessage(db, inbox, {
    subject: "Broken invoice",
    fromAddress: "luis@client.test",
    to: [inbox.address],
    uid: 1,
    messageId: "<invoice@client.test>",
  });
  return { org, inbox, thread, ...people };
}

async function actionRow(id: string) {
  const [row] = await database.db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.id, id));
  return row ?? null;
}

type Draft = { id: string; version: number; bodyText: string; attachments: unknown[] };

describe("undo send", () => {
  test("a send waits out the member's window, can be cancelled inside it, and not after", async () => {
    const { db } = database;
    const { inbox, thread, ana, bea } = await team("undo");
    const file = (await (
      await fetch(new URL(`/api/uploads?mailboxId=${inbox.id}&filename=a.txt`, worker.url), {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "text/plain" },
        body: new Blob(["hello"]),
      })
    ).json()) as { id: string };

    const before = Date.now();
    const reply = await api(
      `/threads/${thread.threadId}/reply`,
      ana.cookie,
      json(
        "POST",
        {
          text: "Fixed, see attached.",
          attachments: [{ kind: "upload", uploadId: file.id }],
        },
        "undo-reply-1",
      ),
    );
    expect(reply.status).toBe(202);
    const sent = (await reply.json()) as { actionId: string; undoUntil: string };
    // Default window: 5 seconds. The mail service's claim skips the row until then.
    const held = new Date(sent.undoUntil).getTime() - before;
    expect(held).toBeGreaterThan(4_000);
    expect(held).toBeLessThan(7_000);
    expect((await actionRow(sent.actionId))?.runAfter.toISOString()).toBe(
      new Date(sent.undoUntil).toISOString(),
    );

    // Only the sender can cancel it.
    expect(
      (await api(`/actions/${sent.actionId}/cancel`, bea.cookie, { method: "POST" })).status,
    ).toBe(404);
    const cancelled = await api(`/actions/${sent.actionId}/cancel`, ana.cookie, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      cancelled: true,
      payload: { text: "Fixed, see attached.", to: ["luis@client.test"] },
    });
    expect(await actionRow(sent.actionId)).toBeNull();
    // The upload is unsent again, so the composer can send it next time.
    const [upload] = await db.select().from(schema.uploads).where(eq(schema.uploads.id, file.id));
    expect(upload?.usedAt).toBeNull();
    expect(
      (await api(`/actions/${sent.actionId}/cancel`, ana.cookie, { method: "POST" })).status,
    ).toBe(404);

    // Once the mail service has claimed a send, cancel answers 409 and the row stays.
    const second = (await (
      await api(
        `/threads/${thread.threadId}/reply`,
        ana.cookie,
        json("POST", { text: "Again" }, "undo-reply-2"),
      )
    ).json()) as { actionId: string };
    await db
      .update(schema.mailActions)
      .set({ status: "running", attempts: 1, lockedAt: new Date() })
      .where(eq(schema.mailActions.id, second.actionId));
    expect(
      (await api(`/actions/${second.actionId}/cancel`, ana.cookie, { method: "POST" })).status,
    ).toBe(409);
    expect(await actionRow(second.actionId)).not.toBeNull();

    // A member who turned undo off sends at once.
    await db
      .insert(schema.memberPreferences)
      .values({ memberId: bea.id, orgId: inbox.orgId, undoSendSeconds: 0 });
    const now = (await (
      await api(
        `/threads/${thread.threadId}/reply`,
        bea.cookie,
        json("POST", { text: "Now" }, "undo-reply-3"),
      )
    ).json()) as { undoUntil: string };
    expect(Math.abs(new Date(now.undoUntil).getTime() - Date.now())).toBeLessThan(2_000);
  });
});

describe("drafts", () => {
  test("a reply draft is shared, a stale autosave cannot overwrite a teammate's, and sending files it", async () => {
    const { db } = database;
    const { inbox, thread, ana, bea, cy } = await team("drafts");

    const created = await api(
      "/drafts",
      ana.cookie,
      json("POST", {
        mailboxId: inbox.id,
        kind: "reply",
        threadId: thread.threadId,
        sourceMessageId: thread.messageId,
        bodyText: "Hi Luis,",
      }),
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as Draft;
    expect(draft.version).toBe(1);

    // Bea sees it on the conversation and saves first; Ana's autosave from version 1 then loses.
    const listed = (await (
      await api(`/drafts?threadId=${thread.threadId}`, bea.cookie)
    ).json()) as { drafts: Draft[] };
    expect(listed.drafts.map((d) => d.id)).toEqual([draft.id]);
    const beaSave = await api(
      `/drafts/${draft.id}`,
      bea.cookie,
      // Keeps the default recipient and copies Marta in.
      json("PUT", {
        version: 1,
        bodyText: "Hi Luis, the fix is out.",
        cc: [{ name: null, address: "marta@client.test" }],
      }),
    );
    expect(((await beaSave.json()) as Draft).version).toBe(2);
    const stale = await api(
      `/drafts/${draft.id}`,
      ana.cookie,
      json("PUT", { version: 1, bodyText: "Hi Luis, hold on" }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      draft: { version: 2, bodyText: "Hi Luis, the fix is out." },
    });

    // Not on the inbox: invisible.
    expect((await api(`/drafts/${draft.id}`, cy.cookie)).status).toBe(404);
    expect(
      (await api(`/drafts/${draft.id}/send`, cy.cookie, { method: "POST", key: "cy-send-1" }))
        .status,
    ).toBe(404);

    // Ana and Bea both click Send on the shared draft at once: one email, the other finds it gone.
    const send = (who: { cookie: string }, key: string) =>
      api(`/drafts/${draft.id}/send`, who.cookie, { method: "POST", key });
    const raced = await Promise.all([send(ana, "draft-send-1"), send(bea, "draft-send-bea")]);
    expect(raced.map((r) => r.status).toSorted()).toEqual([202, 404]);
    const winner =
      raced[0]!.status === 202
        ? { who: ana, key: "draft-send-1" }
        : { who: bea, key: "draft-send-bea" };
    const first = raced.find((r) => r.status === 202)!;
    const { actionId } = (await first.json()) as { actionId: string };
    expect((await actionRow(actionId))?.payload).toMatchObject({
      to: ["luis@client.test"],
      cc: ["marta@client.test"],
      subject: "Re: Broken invoice",
      text: "Hi Luis, the fix is out.",
      inReplyTo: "<invoice@client.test>",
    });
    expect((await api(`/drafts/${draft.id}`, ana.cookie)).status).toBe(404);
    // A retried click (lost response) answers the same send instead of 404 or a second mail.
    const retry = await send(winner.who, winner.key);
    expect(((await retry.json()) as { actionId: string }).actionId).toBe(actionId);
    const sends = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.mailboxId, inbox.id));
    expect(sends).toHaveLength(1);
  });

  test("a forward draft starts with the original's files, and sends what the agent kept", async () => {
    const { db } = database;
    const { org, inbox, thread, ana } = await team("fwddraft");
    const [pdf] = await db
      .insert(schema.attachments)
      .values({
        orgId: org.id,
        messageId: thread.messageId,
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 100,
        r2Key: `${org.id}/${inbox.id}/att/pdf`,
      })
      .returning();
    const draft = (await (
      await api(
        "/drafts",
        ana.cookie,
        json("POST", { mailboxId: inbox.id, kind: "forward", threadId: thread.threadId }),
      )
    ).json()) as Draft;
    expect(draft.attachments).toEqual([{ attachmentId: pdf!.id }]);

    // Sending with no recipient is refused and keeps the draft.
    expect(
      (await api(`/drafts/${draft.id}/send`, ana.cookie, { method: "POST", key: "fwd-draft-0" }))
        .status,
    ).toBe(400);
    await api(
      `/drafts/${draft.id}`,
      ana.cookie,
      json("PUT", { version: 1, to: [{ address: "billing@acme.test" }] }),
    );
    const sent = await api(`/drafts/${draft.id}/send`, ana.cookie, {
      method: "POST",
      key: "fwd-draft-1",
    });
    const { actionId } = (await sent.json()) as { actionId: string };
    expect((await actionRow(actionId))?.payload).toMatchObject({
      to: ["billing@acme.test"],
      subject: "Fwd: Broken invoice",
      attachments: [{ kind: "attachment", attachmentId: pdf!.id }],
    });
  });
});

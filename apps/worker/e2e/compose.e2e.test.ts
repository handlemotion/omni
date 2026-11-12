// Writing mail over the real Worker, its local R2 bucket and Postgres: staged uploads, replies
// and forwards from a shared inbox under the agent's name, and signatures.
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

const UPLOAD_MAX_BYTES = 64 * 1024;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { UPLOAD_MAX_BYTES: String(UPLOAD_MAX_BYTES) },
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
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

function post(path: string, cookie: string, key: string, body: unknown) {
  return api(path, cookie, {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

function upload(
  cookie: string,
  mailboxId: string,
  filename: string,
  bytes: Uint8Array,
  type: string,
) {
  const query = new URLSearchParams({ mailboxId, filename });
  return fetch(new URL(`/api/uploads?${query}`, worker.url), {
    method: "POST",
    headers: { cookie, "content-type": type },
    body: new Blob([new Uint8Array(bytes)]),
  });
}

async function action(id: string) {
  const [row] = await database.db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.id, id));
  return row!;
}

/** A shared inbox with Ana and Bea on its team, and Cy in the same org without access. */
async function team(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await db
    .update(schema.organizations)
    .set({ name: "Acme" })
    .where(eq(schema.organizations.id, org.id));
  const inbox = await createMailbox(db, org.id, `support@${slug}.test`);
  const people = {} as Record<"ana" | "bea" | "cy", { id: string; cookie: string }>;
  for (const name of ["ana", "bea", "cy"] as const) {
    const email = `${name}@${slug}.test`;
    const member = await createMember(db, org.id, email);
    await db
      .update(schema.users)
      .set({ name: name[0]!.toUpperCase() + name.slice(1) })
      .where(eq(schema.users.email, email));
    if (name !== "cy") await grant(db, org.id, inbox.id, member.id);
    people[name] = { id: member.id, cookie: await signIn(worker, db, email) };
  }
  return { org, inbox, ...people };
}

describe("uploads", () => {
  test("a file streams into R2 for the inbox, reads back byte for byte, and no one else sees it", async () => {
    const { inbox, ana, bea, cy } = await team("uploads");
    const bytes = new Uint8Array(40_000).map((_, i) => i % 251);

    const created = await upload(ana.cookie, inbox.id, "logs.bin", bytes, "application/x-logs");
    expect(created.status).toBe(201);
    const file = (await created.json()) as { id: string; size: number; mimeType: string };
    expect(file).toMatchObject({ size: 40_000, mimeType: "application/x-logs" });

    // A teammate on the inbox can open it (the composer is shared); downloads, never inline.
    const read = await api(`/uploads/${file.id}`, bea.cookie);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

    // Not on the inbox: no upload to it, no reading it, no deleting it.
    expect((await upload(cy.cookie, inbox.id, "x.txt", bytes, "text/plain")).status).toBe(404);
    expect((await api(`/uploads/${file.id}`, cy.cookie)).status).toBe(404);
    expect((await api(`/uploads/${file.id}`, cy.cookie, { method: "DELETE" })).status).toBe(404);

    // Over the cap is refused before anything is stored.
    const big = await upload(
      ana.cookie,
      inbox.id,
      "big.bin",
      new Uint8Array(UPLOAD_MAX_BYTES + 1),
      "x/y",
    );
    expect(big.status).toBe(413);
    const rows = await database.db
      .select({ id: schema.uploads.id })
      .from(schema.uploads)
      .where(eq(schema.uploads.mailboxId, inbox.id));
    expect(rows.map((r) => r.id)).toEqual([file.id]);

    // Dropped from the composer: the row and the object go.
    expect((await api(`/uploads/${file.id}`, ana.cookie, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/uploads/${file.id}`, ana.cookie)).status).toBe(404);
  });
});

describe("replies and forwards", () => {
  test("a reply goes out as the inbox under the agent's name, to the chosen message, with its files", async () => {
    const { db } = database;
    const { org, inbox, ana } = await team("reply");
    const first = await seedMessage(db, inbox, {
      subject: "Refund for order 12",
      fromAddress: "luis@client.test",
      to: [inbox.address],
      uid: 1,
      messageId: "<first@client.test>",
      sentAt: new Date("2026-11-01T10:00:00Z"),
    });
    await seedMessage(db, inbox, {
      subject: "Re: Refund for order 12",
      fromAddress: "marta@client.test",
      to: [inbox.address],
      uid: 2,
      messageId: "<second@client.test>",
      threadId: first.threadId,
      sentAt: new Date("2026-11-02T10:00:00Z"),
    });
    const file = (await (
      await upload(
        ana.cookie,
        inbox.id,
        "label.pdf",
        new Uint8Array([37, 80, 68, 70]),
        "application/pdf",
      )
    ).json()) as { id: string };

    // Another org's mailbox and its attachment: a send must not pull its file into this mail.
    const other = await createOrg(db, "globex");
    const otherBox = await createMailbox(db, other.id, "hello@globex.test");
    const foreign = await seedMessage(db, otherBox, {
      subject: "x",
      fromAddress: "a@b.test",
      uid: 1,
    });
    const [secret] = await db
      .insert(schema.attachments)
      .values({
        orgId: other.id,
        messageId: foreign.messageId,
        filename: "payroll.xlsx",
        mimeType: "application/vnd.ms-excel",
        size: 10,
        r2Key: `${other.id}/${otherBox.id}/att/abc`,
      })
      .returning();
    const stolen = await post(`/threads/${first.threadId}/reply`, ana.cookie, "reply-steal-1", {
      text: "Here you go",
      attachments: [{ kind: "attachment", attachmentId: secret!.id }],
    });
    expect(stolen.status).toBe(400);

    const reply = await post(`/threads/${first.threadId}/reply`, ana.cookie, "reply-luis-1", {
      text: "Refund is on its way.",
      messageId: first.messageId,
      attachments: [{ kind: "upload", uploadId: file.id }],
    });
    expect(reply.status).toBe(202);
    const { actionId } = (await reply.json()) as { actionId: string };
    const sent = await action(actionId);
    expect(sent).toMatchObject({ orgId: org.id, mailboxId: inbox.id, memberId: ana.id });
    expect(sent.payload).toMatchObject({
      from: "support@reply.test",
      fromName: "Ana from Acme",
      // To Luis, who wrote the chosen (older) message, threaded under it.
      to: ["luis@client.test"],
      subject: "Re: Refund for order 12",
      inReplyTo: "<first@client.test>",
      references: ["<first@client.test>"],
      inReplyToMessageId: first.messageId,
      attachments: [{ kind: "upload", uploadId: file.id }],
    });
    // The refused request queued nothing.
    const queued = await db
      .select({ id: schema.mailActions.id })
      .from(schema.mailActions)
      .where(eq(schema.mailActions.mailboxId, inbox.id));
    expect(queued.map((a) => a.id)).toEqual([actionId]);

    // Taken by the send: the expiry cleanup and the composer's delete leave it alone.
    const [used] = await db
      .select({ usedAt: schema.uploads.usedAt })
      .from(schema.uploads)
      .where(eq(schema.uploads.id, file.id));
    expect(used?.usedAt).not.toBeNull();
    expect((await api(`/uploads/${file.id}`, ana.cookie, { method: "DELETE" })).status).toBe(404);

    // The helpdesk side: the reply took the open conversation to pending, Ana claimed it by
    // replying, and the first response is on record.
    const [conversation] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, first.threadId));
    expect(conversation).toMatchObject({ status: "pending", assigneeMemberId: ana.id });
    expect(conversation?.firstRespondedAt).toBeInstanceOf(Date);

    // A retry (lost response) answers with the same send, though the upload is now used.
    const retried = await post(`/threads/${first.threadId}/reply`, ana.cookie, "reply-luis-1", {
      text: "Refund is on its way.",
      messageId: first.messageId,
      attachments: [{ kind: "upload", uploadId: file.id }],
    });
    expect(((await retried.json()) as { actionId: string }).actionId).toBe(actionId);
  });

  test("an upload left unsent past its expiry cannot be sent", async () => {
    const { db } = database;
    const { inbox, ana } = await team("expired");
    const file = (await (
      await upload(ana.cookie, inbox.id, "old.txt", new Uint8Array([1]), "text/plain")
    ).json()) as { id: string };
    await db
      .update(schema.uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.uploads.id, file.id));
    const send = await post("/send", ana.cookie, "send-expired-1", {
      mailboxId: inbox.id,
      to: ["luis@client.test"],
      subject: "Docs",
      text: "Attached.",
      attachments: [{ kind: "upload", uploadId: file.id }],
    });
    expect(send.status).toBe(400);
  });

  test("a forward quotes the original under its headers and carries its files, not its inline images", async () => {
    const { db } = database;
    const { org, inbox, bea } = await team("forward");
    const original = await seedMessage(db, inbox, {
      subject: "Broken invoice",
      fromAddress: "luis@client.test",
      fromName: "Luis Pérez",
      to: [inbox.address],
      uid: 1,
      sentAt: new Date("2026-11-03T09:30:00Z"),
      text: "The PDF will not open.",
    });
    const [pdf, logo] = await db
      .insert(schema.attachments)
      .values([
        {
          orgId: org.id,
          messageId: original.messageId,
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 100,
          r2Key: `${org.id}/${inbox.id}/att/pdf`,
        },
        {
          orgId: org.id,
          messageId: original.messageId,
          filename: "logo.png",
          mimeType: "image/png",
          size: 10,
          r2Key: `${org.id}/${inbox.id}/att/logo`,
          inline: true,
          contentId: "logo@client",
        },
      ])
      .returning();
    expect(logo).toBeDefined();

    const forward = await post(`/threads/${original.threadId}/forward`, bea.cookie, "forward-1", {
      to: ["billing@acme.test"],
      text: "Can you resend this one?",
    });
    expect(forward.status).toBe(202);
    const { actionId } = (await forward.json()) as { actionId: string };
    const { payload } = await action(actionId);
    expect(payload).toMatchObject({
      from: "support@forward.test",
      fromName: "Bea from Acme",
      to: ["billing@acme.test"],
      subject: "Fwd: Broken invoice",
      inReplyToMessageId: original.messageId,
      attachments: [{ kind: "attachment", attachmentId: pdf!.id }],
    });
    // A forward starts a new conversation for the recipient: no reply headers.
    expect(payload).not.toHaveProperty("inReplyTo");
    expect(payload.text).toBe(
      [
        "Can you resend this one?",
        "",
        "---------- Forwarded message ---------",
        "From: Luis Pérez <luis@client.test>",
        "Date: Tue, 03 Nov 2026 09:30:00 GMT",
        "Subject: Broken invoice",
        "To: support@forward.test",
        "",
        "The PDF will not open.",
      ].join("\n"),
    );

    const bare = await post(`/threads/${original.threadId}/forward`, bea.cookie, "forward-2", {
      to: ["billing@acme.test"],
      includeAttachments: false,
    });
    expect(
      (await action(((await bare.json()) as { actionId: string }).actionId)).payload,
    ).not.toHaveProperty("attachments");

    // With 50 more files on the original, the forward would carry 51: the mail service would
    // reject that payload for good, so the Worker refuses it up front and queues nothing.
    await db.insert(schema.attachments).values(
      Array.from({ length: 50 }, (_, i) => ({
        orgId: org.id,
        messageId: original.messageId,
        filename: `page-${i}.pdf`,
        mimeType: "application/pdf",
        size: 1,
        r2Key: `${org.id}/${inbox.id}/att/page-${i}`,
      })),
    );
    const tooMany = await post(`/threads/${original.threadId}/forward`, bea.cookie, "forward-3", {
      to: ["billing@acme.test"],
    });
    expect(tooMany.status).toBe(400);
    const queued = await db
      .select({ id: schema.mailActions.id })
      .from(schema.mailActions)
      .where(eq(schema.mailActions.mailboxId, inbox.id));
    expect(queued).toHaveLength(2);
  });
});

describe("signatures", () => {
  test("the inbox's signature is shared with the team; a member's own is theirs alone", async () => {
    const { inbox, ana, bea, cy } = await team("signatures");
    const put = (cookie: string, scope: string, bodyText: string) =>
      api(`/mailboxes/${inbox.id}/signature?scope=${scope}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ bodyText }),
      });

    expect((await put(ana.cookie, "inbox", "— The Acme support team")).status).toBe(200);
    expect((await put(ana.cookie, "mine", "Ana, Acme support")).status).toBe(200);
    // Saving again replaces, never adds a second row.
    expect((await put(ana.cookie, "mine", "Ana P., Acme support")).status).toBe(200);

    const read = async (cookie: string) =>
      (await (await api(`/mailboxes/${inbox.id}/signature`, cookie)).json()) as {
        inbox: { bodyText: string } | null;
        mine: { bodyText: string } | null;
      };
    expect(await read(ana.cookie)).toMatchObject({
      inbox: { bodyText: "— The Acme support team" },
      mine: { bodyText: "Ana P., Acme support" },
    });
    expect(await read(bea.cookie)).toMatchObject({
      inbox: { bodyText: "— The Acme support team" },
      mine: null,
    });

    // Not on the inbox: cannot read or change its signature.
    expect((await api(`/mailboxes/${inbox.id}/signature`, cy.cookie)).status).toBe(404);
    expect((await put(cy.cookie, "inbox", "hacked")).status).toBe(404);

    const removed = await api(`/mailboxes/${inbox.id}/signature?scope=mine`, ana.cookie, {
      method: "DELETE",
    });
    expect(await removed.json()).toMatchObject({
      mine: null,
      inbox: { bodyText: "— The Acme support team" },
    });
  });
});

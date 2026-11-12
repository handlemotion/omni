// Canned replies over the real Worker and Postgres: who sees and changes an inbox's replies and a
// member's own, and how a reply fills in for one conversation.
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

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

/** Two inboxes in one org: Ana and Bea on support@, Cy on sales@ only. */
async function team(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await db
    .update(schema.organizations)
    .set({ name: "Acme" })
    .where(eq(schema.organizations.id, org.id));
  const support = await createMailbox(db, org.id, `support@${slug}.test`);
  const sales = await createMailbox(db, org.id, `sales@${slug}.test`);
  const people = {} as Record<"ana" | "bea" | "cy", { id: string; cookie: string }>;
  for (const name of ["ana", "bea", "cy"] as const) {
    const email = `${name}@${slug}.test`;
    const member = await createMember(db, org.id, email);
    await db
      .update(schema.users)
      .set({ name: `${name[0]!.toUpperCase()}${name.slice(1)} Example` })
      .where(eq(schema.users.email, email));
    await grant(db, org.id, name === "cy" ? sales.id : support.id, member.id);
    people[name] = { id: member.id, cookie: await signIn(worker, db, email) };
  }
  const [refund, billing] = await db
    .insert(schema.tags)
    .values([
      { orgId: org.id, mailboxId: support.id, name: "refund" },
      { orgId: org.id, mailboxId: sales.id, name: "lead" },
    ])
    .returning();
  return { org, support, sales, refundTag: refund!, salesTag: billing!, ...people };
}

type Reply = { id: string; title: string; scope: string };

describe("canned replies", () => {
  test("an inbox's replies are the team's; a member's own are theirs alone", async () => {
    const { support, refundTag, salesTag, ana, bea, cy } = await team("canned");

    const shared = await api(
      "/canned-replies",
      ana.cookie,
      json("POST", {
        mailboxId: support.id,
        title: "Refund issued",
        bodyText: "Hi {{customer.first_name | there}}, your refund is on its way.",
        setStatus: "resolved",
        addTagIds: [refundTag.id],
      }),
    );
    expect(shared.status).toBe(201);
    const inboxReply = (await shared.json()) as Reply;
    expect(inboxReply.scope).toBe("inbox");
    const mine = (await (
      await api(
        "/canned-replies",
        ana.cookie,
        json("POST", { title: "My sign-off", bodyText: "Cheers, Ana" }),
      )
    ).json()) as Reply;
    expect(mine.scope).toBe("personal");

    // Another inbox's tag, or a tag on a personal reply, is refused.
    const wrongTag = await api(
      "/canned-replies",
      ana.cookie,
      json("POST", {
        mailboxId: support.id,
        title: "x",
        bodyText: "x",
        addTagIds: [salesTag.id],
      }),
    );
    expect(wrongTag.status).toBe(400);
    const personalTag = await api(
      `/canned-replies/${mine.id}`,
      ana.cookie,
      json("PATCH", { addTagIds: [refundTag.id] }),
    );
    expect(personalTag.status).toBe(400);

    const list = async (cookie: string) =>
      (
        (await (await api(`/canned-replies?mailboxId=${support.id}`, cookie)).json()) as {
          replies: Reply[];
        }
      ).replies.map((r) => r.title);
    expect(await list(ana.cookie)).toEqual(["My sign-off", "Refund issued"]);
    expect(await list(bea.cookie)).toEqual(["Refund issued"]);
    // Cy is not on support@: asking for its replies shows only Cy's own (none).
    expect(await list(cy.cookie)).toEqual([]);

    // A teammate may edit the inbox's reply, but not Ana's own; Cy may touch neither.
    const edited = await api(
      `/canned-replies/${inboxReply.id}`,
      bea.cookie,
      json("PATCH", { title: "Refund sent" }),
    );
    expect(edited.status).toBe(200);
    for (const [cookie, id] of [
      [bea.cookie, mine.id],
      [cy.cookie, inboxReply.id],
    ] as const) {
      expect(
        (await api(`/canned-replies/${id}`, cookie, json("PATCH", { title: "x" }))).status,
      ).toBe(404);
      expect((await api(`/canned-replies/${id}`, cookie, { method: "DELETE" })).status).toBe(404);
    }
    expect((await api(`/canned-replies/${mine.id}`, ana.cookie, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(await list(ana.cookie)).toEqual(["Refund sent"]);
  });

  test("a reply fills in the conversation's customer and agent, escaped in HTML, only in its own inbox", async () => {
    const { db } = database;
    const { support, sales, refundTag, ana, cy } = await team("render");
    const thread = await seedMessage(db, support, {
      subject: "Where is my refund?",
      fromAddress: "luis@client.test",
      fromName: "Luis <b>Pérez</b>",
      to: [support.address],
      uid: 1,
    });
    // The agent's own later reply in the thread must not become "the customer".
    await seedMessage(db, support, {
      subject: "Re: Where is my refund?",
      fromAddress: support.address,
      uid: 2,
      threadId: thread.threadId,
      sentAt: new Date(Date.now() + 1000),
    });
    const reply = (await (
      await api(
        "/canned-replies",
        ana.cookie,
        json("POST", {
          mailboxId: support.id,
          title: "Refund issued",
          bodyText:
            "Hi {{customer.first_name}}, {{agent.first_name}} from {{org.name}} here. Order {{order.id}}.",
          bodyHtml: "<p>Hi {{customer.name}}</p>",
          setStatus: "resolved",
          addTagIds: [refundTag.id],
        }),
      )
    ).json()) as Reply;

    const rendered = await api(
      `/canned-replies/${reply.id}/render`,
      ana.cookie,
      json("POST", { threadId: thread.threadId }),
    );
    expect(await rendered.json()).toEqual({
      text: "Hi Luis, Ana from Acme here. Order .",
      html: "<p>Hi Luis &lt;b&gt;Pérez&lt;/b&gt;</p>",
      missing: ["order.id"],
      setStatus: "resolved",
      addTagIds: [refundTag.id],
    });

    // A support@ reply on a sales@ conversation, or rendered by someone who can't see the thread.
    const salesThread = await seedMessage(db, sales, {
      subject: "Pricing",
      fromAddress: "a@b.test",
      uid: 1,
    });
    expect(
      (
        await api(
          `/canned-replies/${reply.id}/render`,
          ana.cookie,
          json("POST", { threadId: salesThread.threadId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(
          `/canned-replies/${reply.id}/render`,
          cy.cookie,
          json("POST", { threadId: thread.threadId }),
        )
      ).status,
    ).toBe(404);
  });
});

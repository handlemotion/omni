// A CRM record's timeline over the real Worker (docs/spec/crm.md "The timeline"): its events,
// notes and the threads involving its addresses, merged newest first. Mail is stored the way the
// mail service stores it (`upsertMessage`, which also fills `thread_participants`).
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";
import { createMailbox, grant, seedMessage } from "./support.ts";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

// oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
const threadsIn = (body: any) =>
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  body.items.filter((item: any) => item.kind === "thread").map((item: any) => item.thread.subject);

test("two members open one person's timeline: each sees the thread from the inbox they are on, and neither sees the other's", async () => {
  const { db, api } = stack;
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const sales = await createMailbox(db, acme.id, "sales@acme.test");
  const support = await createMailbox(db, acme.id, "support@acme.test");
  await grant(db, acme.id, sales.id, ana.id);
  await grant(db, acme.id, support.id, bea.id);
  await seedMessage(db, sales, {
    subject: "Quote for Northwind",
    fromAddress: "Carla@Northwind.com",
    to: ["sales@acme.test"],
    uid: 1,
  });
  await seedMessage(db, support, {
    subject: "Login broken",
    fromAddress: "support@acme.test",
    to: ["carla@northwind.com"],
    uid: 1,
  });
  // Anyone else at the company's domain shows on the company, not on Carla.
  await seedMessage(db, sales, {
    subject: "Invoice question",
    fromAddress: "dan@northwind.com",
    uid: 2,
  });

  const added = await api(ana.jar, "POST", "/people", {
    name: "Carla",
    address: "carla@northwind.com",
  });
  expect(added.status).toBe(201);
  const { id, companyId } = added.body.person;

  const anaView = await api(ana.jar, "GET", `/people/${id}/timeline`);
  expect(anaView.status).toBe(200);
  expect(threadsIn(anaView.body)).toEqual(["Quote for Northwind"]);
  expect(anaView.body.items).toContainEqual(
    expect.objectContaining({ kind: "event", event: expect.objectContaining({ kind: "created" }) }),
  );
  const thread = anaView.body.items.find((item: { kind: string }) => item.kind === "thread");
  expect(thread.thread).toMatchObject({
    mailboxId: sales.id,
    url: expect.stringContaining("/all/"),
  });

  const beaView = await api(bea.jar, "GET", `/people/${id}/timeline`);
  expect(threadsIn(beaView.body)).toEqual(["Login broken"]);

  // The company adds its domain: Ana sees Dan's thread there too, Bea still only hers.
  const anaCompany = await api(ana.jar, "GET", `/companies/${companyId}/timeline`);
  expect(threadsIn(anaCompany.body).toSorted()).toEqual([
    "Invoice question",
    "Quote for Northwind",
  ]);
  const beaCompany = await api(bea.jar, "GET", `/companies/${companyId}/timeline`);
  expect(threadsIn(beaCompany.body)).toEqual(["Login broken"]);
});

test("paging a timeline in small pages returns every item once, newest first, across events, notes and threads", async () => {
  const { db, api } = stack;
  const org = await stack.company("paging");
  const ana = await stack.member(org.id);
  const inbox = await createMailbox(db, org.id, "hello@paging.test");
  await grant(db, org.id, inbox.id, ana.id);
  const person = (await api(ana.jar, "POST", "/people", { name: "Eve", address: "eve@globex.com" }))
    .body.person;
  const notes = [];
  for (const body of ["first", "second", "third"]) {
    notes.push((await api(ana.jar, "POST", "/notes", { personId: person.id, body })).body.note);
  }
  // Threads at the very millisecond of a note, and around it: ties are broken by id alone.
  let uid = 1;
  for (const note of notes) {
    const at = new Date(note.createdAt);
    for (const offset of [-1, 0, 0]) {
      await seedMessage(db, inbox, {
        subject: `Thread ${uid}`,
        fromAddress: "eve@globex.com",
        uid: uid++,
        sentAt: new Date(at.getTime() + offset),
      });
    }
  }

  const whole = await api(ana.jar, "GET", `/people/${person.id}/timeline?limit=50`);
  expect(whole.body.nextCursor).toBeNull();
  // One event (created), three notes, nine threads.
  expect(whole.body.items).toHaveLength(13);
  const order = whole.body.items.map((item: { at: string; id: string }) => `${item.at} ${item.id}`);
  expect(order).toEqual(order.toSorted().toReversed());

  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${cursor}` : "";
    const page = await api(ana.jar, "GET", `/people/${person.id}/timeline?limit=2${query}`);
    expect(page.status).toBe(200);
    paged.push(...page.body.items.map((item: { id: string }) => item.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  expect(paged).toEqual(whole.body.items.map((item: { id: string }) => item.id));
});

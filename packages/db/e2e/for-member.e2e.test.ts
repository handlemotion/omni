import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  conflictingLock,
  findMemberDomain,
  listMemberDomains,
  lockClaim,
  MAX_PENDING_CLAIMS,
  openClaim,
  recordChallengeState,
  releaseDomain,
  transferDomain,
} from "../src/domains.ts";
import { forMember, forUser } from "../src/for-member.ts";
import {
  mailboxes as schemaMailboxes,
  mailDomains,
  members,
  threadState,
  threads,
} from "../src/schema/index.ts";
import { listUserWorkspaces } from "../src/workspaces.ts";
import { createThread, enqueueAction, upsertMessage } from "../src/writers.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

async function seedThread(
  orgId: string,
  mailboxId: string,
  text: string,
  triage?: { bucket: "needs_reply" | "fyi"; confidence: number; source: "ai" | "person" },
) {
  const threadId = await createThread(db, {
    orgId,
    mailboxId,
    subjectKey: text,
    lastMessageAt: new Date("2026-10-01T00:00:00Z"),
  });
  if (triage) {
    await db
      .update(threads)
      .set({
        triage: triage.bucket,
        triageConfidence: triage.confidence,
        triageSource: triage.source,
      })
      .where(eq(threads.id, threadId));
  }
  const message = await upsertMessage(db, {
    orgId,
    mailboxId,
    threadId,
    messageIdHeader: `<${threadId}@example.test>`,
    subject: `About ${text}`,
    fromAddress: "sender@example.test",
    sentAt: new Date("2026-10-01T00:00:00Z"),
    cleanText: `Please look at the ${text} details.`,
  });
  return { threadId, messageId: message.id };
}

describe("forMember isolation", () => {
  // Org A: alice sees hello@, bob sees billing@. Org B: carol sees ops@, and holds a forged
  // grant on org A's hello@ (a buggy or malicious write must not open another org's mail).
  let alice: string, bob: string, carol: string;
  let carolUser: string, orgAId: string, orgBId: string, opsBoxId: string;
  let hello: { threadId: string; messageId: string };
  let billing: { threadId: string; messageId: string };
  let ops: { threadId: string; messageId: string };

  beforeAll(async () => {
    const orgA = await createOrg(db, "org-a");
    const orgB = await createOrg(db, "org-b");
    alice = (await createMember(db, orgA.id, "alice")).id;
    bob = (await createMember(db, orgA.id, "bob")).id;
    const carolMember = await createMember(db, orgB.id, "carol");
    carol = carolMember.id;
    carolUser = carolMember.userId;
    orgAId = orgA.id;
    orgBId = orgB.id;
    const helloBox = await createMailbox(db, orgA.id, "hello@a.test");
    const billingBox = await createMailbox(db, orgA.id, "billing@a.test");
    const opsBox = await createMailbox(db, orgB.id, "ops@b.test");
    await grant(db, orgA.id, helloBox.id, alice);
    await grant(db, orgA.id, billingBox.id, bob);
    await grant(db, orgB.id, opsBox.id, carol);
    opsBoxId = opsBox.id;
    await grant(db, orgA.id, helloBox.id, carol);
    hello = await seedThread(orgA.id, helloBox.id, "pelican");
    billing = await seedThread(orgA.id, billingBox.id, "flamingo");
    ops = await seedThread(orgB.id, opsBox.id, "albatross");
  });

  test("a member reads only threads, messages and search hits from mailboxes they were granted", async () => {
    const asAlice = forMember(db, alice);
    expect((await asAlice.listThreads()).map((t) => t.id)).toEqual([hello.threadId]);
    expect((await asAlice.listThreads({ view: "all" })).map((t) => t.id)).toEqual([hello.threadId]);
    expect((await asAlice.getThread(hello.threadId))?.messages.map((m) => m.id)).toEqual([
      hello.messageId,
    ]);
    expect(await asAlice.getThread(billing.threadId)).toBeNull();
    expect(await asAlice.getThread(ops.threadId)).toBeNull();
    expect(await asAlice.search("flamingo")).toEqual([]);
    expect(await asAlice.search("albatross")).toEqual([]);

    // Bob, same org, other mailbox: the hit exists, so the empty results above are scoping.
    expect((await forMember(db, bob).search("flamingo")).map((h) => h.messageId)).toEqual([
      billing.messageId,
    ]);
  });

  test("a grant that crosses orgs opens nothing", async () => {
    const asCarol = forMember(db, carol);
    expect((await asCarol.listThreads()).map((t) => t.id)).toEqual([ops.threadId]);
    expect((await asCarol.listThreads({ view: "all" })).map((t) => t.id)).toEqual([ops.threadId]);
    expect(await asCarol.getThread(hello.threadId)).toBeNull();
    expect(await asCarol.search("pelican")).toEqual([]);
    expect(await asCarol.setThreadState(hello.threadId, { read: true })).toBeNull();
  });

  test("the workspace switcher lists only the user's orgs and the mailboxes granted to them there", async () => {
    // Carol also joins org A, with no grant there of her own: only the forged one from org B.
    await db.insert(members).values({
      id: crypto.randomUUID(),
      organizationId: orgAId,
      userId: carolUser,
      createdAt: new Date(),
    });
    const workspaces = await listUserWorkspaces(db, carolUser);
    expect(workspaces.map((w) => [w.id, w.mailboxes.map((m) => m.id)])).toEqual([
      [orgBId, [opsBoxId]],
      [orgAId, []],
    ]);
    // Alice's view is her own org and hello@ only: never billing@ (Bob's) or org B.
    const [aliceRow] = await db.select().from(members).where(eq(members.id, alice));
    expect(
      (await listUserWorkspaces(db, aliceRow!.userId)).map((w) => [
        w.id,
        w.mailboxes.map((m) => m.address),
      ]),
    ).toEqual([[orgAId, ["hello@a.test"]]]);
  });

  test("thread state is per member and cannot be written without access", async () => {
    expect(await forMember(db, alice).setThreadState(billing.threadId, { read: true })).toBeNull();
    expect(
      await db.select().from(threadState).where(eq(threadState.threadId, billing.threadId)),
    ).toEqual([]);

    const asBob = forMember(db, bob);
    await asBob.setThreadState(billing.threadId, { read: true });
    await asBob.setThreadState(billing.threadId, { deferredUntil: new Date("2027-01-01Z") });
    const [thread] = await asBob.listThreads({ view: "queue" });
    expect(thread).toMatchObject({ read: true, deferredUntil: new Date("2027-01-01Z") });

    // Done through a time later than the thread's newest message is capped at that message, and
    // Alice cannot mark Bob's thread done.
    expect(
      await forMember(db, alice).setThreadState(billing.threadId, { doneThrough: new Date() }),
    ).toBeNull();
    const done = await asBob.setThreadState(billing.threadId, {
      doneThrough: new Date("2030-01-01Z"),
    });
    expect(done).toMatchObject({ done: true, doneThrough: new Date("2026-10-01T00:00:00Z") });
    expect((await asBob.listThreads({ view: "done" })).map((t) => t.id)).toEqual([
      billing.threadId,
    ]);
    expect(await forMember(db, alice).listThreads({ view: "done" })).toEqual([]);
  });

  test("counts and outbox actions cover only the member's own grants and requests", async () => {
    expect((await forMember(db, alice).counts()).map((c) => c.mailboxId)).toEqual([
      (await forMember(db, alice).listThreads())[0]!.mailboxId,
    ]);
    // Carol's forged grant on org A's mailbox counts nothing there.
    const carolCounts = await forMember(db, carol).counts();
    expect(carolCounts).toHaveLength(1);
    expect(carolCounts[0]!.inbox).toBe(1);

    const [helloThread] = await forMember(db, alice).listThreads();
    const action = await enqueueAction(db, {
      orgId: helloThread!.orgId,
      mailboxId: helloThread!.mailboxId,
      memberId: alice,
      kind: "send",
      payload: { from: "hello@a.test", to: ["x@example.test"], subject: "hi" },
      idempotencyKey: `${alice}:counts-test`,
    });
    expect(await forMember(db, alice).getAction(action.id)).toMatchObject({
      id: action.id,
      status: "pending",
    });
    expect(await forMember(db, bob).getAction(action.id)).toBeNull();
    expect(await forMember(db, carol).getAction(action.id)).toBeNull();
  });
});

describe("forUser across workspaces", () => {
  // Uma belongs to org X (member ux) and org Y (member uy). X: inbox@ granted to ux, sales@
  // granted only to Vic. Y: desk@ granted to uy, plus a forged grant for uy on X's sales@. Org Z
  // has mail and no Uma at all.
  let uma: string, ux: string, uy: string, orgXId: string, orgYId: string;
  let xInbox: string, xSales: string, yDesk: string, zDesk: string;

  async function threadAt(orgId: string, mailboxId: string, text: string, at: string) {
    const { threadId } = await seedThread(orgId, mailboxId, text);
    await db
      .update(threads)
      .set({ lastMessageAt: new Date(at) })
      .where(eq(threads.id, threadId));
    return threadId;
  }

  beforeAll(async () => {
    const orgX = await createOrg(db, "user-org-x");
    const orgY = await createOrg(db, "user-org-y");
    const orgZ = await createOrg(db, "user-org-z");
    orgXId = orgX.id;
    orgYId = orgY.id;
    const uxMember = await createMember(db, orgX.id, "uma");
    ux = uxMember.id;
    uma = uxMember.userId;
    uy = crypto.randomUUID();
    await db
      .insert(members)
      .values({ id: uy, organizationId: orgY.id, userId: uma, createdAt: new Date() });
    const vic = (await createMember(db, orgX.id, "vic")).id;
    const zed = (await createMember(db, orgZ.id, "zed")).id;

    const inboxBox = await createMailbox(db, orgX.id, "inbox@x.test");
    const salesBox = await createMailbox(db, orgX.id, "sales@x.test");
    const deskBox = await createMailbox(db, orgY.id, "desk@y.test");
    const zBox = await createMailbox(db, orgZ.id, "desk@z.test");
    await grant(db, orgX.id, inboxBox.id, ux);
    await grant(db, orgX.id, salesBox.id, vic);
    await grant(db, orgY.id, deskBox.id, uy);
    await grant(db, orgX.id, salesBox.id, uy); // forged: a Y member on an X mailbox
    await grant(db, orgZ.id, zBox.id, zed);

    // Interleaved in time across orgs, so newest-first must merge the two workspaces.
    xInbox = await threadAt(orgX.id, inboxBox.id, "kestrel", "2026-10-04T00:00:00Z");
    yDesk = await threadAt(orgY.id, deskBox.id, "osprey", "2026-10-03T00:00:00Z");
    await threadAt(orgX.id, inboxBox.id, "merlin", "2026-10-02T00:00:00Z");
    await threadAt(orgY.id, deskBox.id, "harrier", "2026-10-01T00:00:00Z");
    xSales = await threadAt(orgX.id, salesBox.id, "condor", "2026-10-05T00:00:00Z");
    zDesk = await threadAt(orgZ.id, zBox.id, "vulture", "2026-10-06T00:00:00Z");
  });

  test("lists every workspace's granted threads newest first, paged by cursor, and nothing else", async () => {
    const asUma = forUser(db, uma);
    const all = await asUma.listThreads({ view: "all" });
    expect(all.map((t) => [t.orgId, t.subject])).toEqual([
      [orgXId, "About kestrel"],
      [orgYId, "About osprey"],
      [orgXId, "About merlin"],
      [orgYId, "About harrier"],
    ]);
    // Page by page with a one-row limit: the same order, each thread once.
    const paged: string[] = [];
    let before: { lastMessageAt: Date; id: string } | undefined;
    for (;;) {
      const page = await asUma.listThreads({ view: "all", limit: 1, before });
      if (!page.length) break;
      paged.push(page[0]!.id);
      before = page[0]!;
    }
    expect(paged).toEqual(all.map((t) => t.id));

    // Neither sales@ (no grant in X; the forged Y grant opens nothing) nor org Z.
    for (const id of [xSales, zDesk]) {
      expect(await asUma.getThread(id)).toBeNull();
      expect(await asUma.memberFor(id)).toBeNull();
    }
    expect((await asUma.getThread(yDesk))?.orgId).toBe(orgYId);
  });

  test("state and counts are each workspace member's own, and a thread names its member", async () => {
    const asUma = forUser(db, uma);
    expect((await asUma.memberFor(xInbox))?.id).toBe(ux);
    expect((await asUma.memberFor(yDesk))?.id).toBe(uy);

    // Acting as the org Y member shows through the user's list; org X's threads are untouched.
    await forMember(db, uy).setThreadState(yDesk, {
      doneThrough: new Date("2026-10-03T00:00:00Z"),
    });
    await forMember(db, ux).setThreadState(xInbox, { read: true });
    const inbox = await asUma.listThreads();
    expect(inbox.map((t) => [t.subject, t.read])).toEqual([
      ["About kestrel", true],
      ["About merlin", false],
      ["About harrier", false],
    ]);
    expect((await asUma.listThreads({ view: "done" })).map((t) => t.id)).toEqual([yDesk]);

    const counts = await asUma.counts();
    expect(
      counts
        .map((c) => [c.orgId, c.inbox, c.unread])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [orgXId, 2, 1],
        [orgYId, 1, 1],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });
});

test("a deferral hides the thread from the member's inbox until its time, and only theirs", async () => {
  const org = await createOrg(db, "snooze-org");
  const dana = (await createMember(db, org.id, "dana")).id;
  const erin = (await createMember(db, org.id, "erin")).id;
  const shared = await createMailbox(db, org.id, "team@snooze.test");
  await grant(db, org.id, shared.id, dana);
  await grant(db, org.id, shared.id, erin);
  const { threadId } = await seedThread(org.id, shared.id, "heron");
  const ids = async (member: string, view: "inbox" | "queue") =>
    (await forMember(db, member).listThreads({ view })).map((t) => t.id);

  await forMember(db, dana).setThreadState(threadId, {
    deferredUntil: new Date(Date.now() + 3_600_000),
  });
  expect(await ids(dana, "inbox")).toEqual([]);
  expect(await ids(dana, "queue")).toEqual([threadId]);
  expect(await ids(erin, "inbox")).toEqual([threadId]);
  expect(await forMember(db, dana).counts()).toMatchObject([{ inbox: 0, unread: 0, queue: 1 }]);
  expect(await forMember(db, erin).counts()).toMatchObject([{ inbox: 1, unread: 1, queue: 0 }]);

  // The time passes: back in the inbox with nothing left to do.
  await forMember(db, dana).setThreadState(threadId, {
    deferredUntil: new Date(Date.now() - 1_000),
  });
  expect(await ids(dana, "inbox")).toEqual([threadId]);
  expect(await ids(dana, "queue")).toEqual([]);
});

test("a list row summarizes the thread: latest message, senders once each, count, attachments", async () => {
  const org = await createOrg(db, "row-org");
  const gil = (await createMember(db, org.id, "gil")).id;
  const box = await createMailbox(db, org.id, "gil@row.test");
  await grant(db, org.id, box.id, gil);
  const threadId = await createThread(db, {
    orgId: org.id,
    mailboxId: box.id,
    subjectKey: "kiln",
    lastMessageAt: new Date("2026-10-03T00:00:00Z"),
  });
  const message = (n: number, from: string, name: string, text: string, files = false) =>
    upsertMessage(db, {
      orgId: org.id,
      mailboxId: box.id,
      threadId,
      messageIdHeader: `<kiln-${n}@row.test>`,
      subject: n === 1 ? "Kiln quote" : "Re: Kiln quote",
      fromName: name,
      fromAddress: from,
      sentAt: new Date(`2026-10-0${n}T00:00:00Z`),
      cleanText: text,
      attachments: files
        ? [{ filename: "q.pdf", mimeType: "application/pdf", size: 3, r2Key: "k" }]
        : [],
    });
  await message(1, "ana@studio.test", "Ana", "Can you quote the kiln?");
  await message(3, "ANA@studio.test", "Ana S.", "Thanks!\n\n  See   attached.", true);
  await message(2, "gil@row.test", "Gil", "Sure, 400.");

  const [row] = await forMember(db, gil).listThreads();
  expect(row).toMatchObject({
    subject: "Re: Kiln quote",
    snippet: "Thanks! See attached.",
    latestFrom: { name: "Ana S.", address: "ANA@studio.test" },
    participants: [
      { name: "Ana", address: "ana@studio.test" },
      { name: "Gil", address: "gil@row.test" },
    ],
    messageCount: 3,
    hasAttachments: true,
    unread: true,
  });
});

test("full-text search matches stemmed words in clean_text", async () => {
  const org = await createOrg(db, "search-org");
  const member = (await createMember(db, org.id, "dana")).id;
  const box = await createMailbox(db, org.id, "dana@search.test");
  await grant(db, org.id, box.id, member);
  const { messageId } = await seedThread(org.id, box.id, "quarterly invoicing");

  const hits = await forMember(db, member).search("invoices");
  expect(hits.map((h) => h.messageId)).toEqual([messageId]);
});

test("lanes split AI triage at the auto-file confidence; person triage always files", async () => {
  const org = await createOrg(db, "lane-org");
  const member = (await createMember(db, org.id, "eve")).id;
  const box = await createMailbox(db, org.id, "eve@lane.test");
  await grant(db, org.id, box.id, member);
  const sure = await seedThread(org.id, box.id, "sure", {
    bucket: "needs_reply",
    confidence: 0.9,
    source: "ai",
  });
  const unsure = await seedThread(org.id, box.id, "unsure", {
    bucket: "needs_reply",
    confidence: 0.6,
    source: "ai",
  });
  const person = await seedThread(org.id, box.id, "person", {
    bucket: "needs_reply",
    confidence: 0.1,
    source: "person",
  });

  const scoped = forMember(db, member);
  const ids = async (lane: "needs_reply" | "unsure") =>
    (await scoped.listThreads({ lane })).map((t) => t.id).toSorted();
  expect(await ids("needs_reply")).toEqual([sure.threadId, person.threadId].toSorted());
  expect(await ids("unsure")).toEqual([unsure.threadId]);
});

test("thread pages and search merge granted mailboxes newest first, each row once, ties included", async () => {
  // Lists and search take the newest rows of each granted mailbox and merge them, so a page
  // boundary that falls on a timestamp shared across mailboxes is where rows get lost or repeated.
  const org = await createOrg(db, "page-org");
  const member = (await createMember(db, org.id, "frank")).id;
  const sales = await createMailbox(db, org.id, "sales@page.test");
  const support = await createMailbox(db, org.id, "support@page.test");
  const hidden = await createMailbox(db, org.id, "hidden@page.test");
  await grant(db, org.id, sales.id, member);
  await grant(db, org.id, support.id, member);

  const at = (day: number) => new Date(Date.UTC(2026, 9, day));
  const days = [5, 4, 4, 4, 3, 2, 1];
  const seeded: { threadId: string; messageId: string; mailboxId: string; sentAt: Date }[] = [];
  for (const [i, day] of days.entries()) {
    const mailboxId = [sales.id, support.id, hidden.id][i % 3]!;
    const threadId = await createThread(db, {
      orgId: org.id,
      mailboxId,
      subjectKey: `walrus ${i}`,
      lastMessageAt: at(day),
    });
    const { id } = await upsertMessage(db, {
      orgId: org.id,
      mailboxId,
      threadId,
      messageIdHeader: `<walrus-${i}@page.test>`,
      subject: `Walrus ${i}`,
      fromAddress: "sender@example.test",
      sentAt: at(day),
      cleanText: "walrus migration notes",
    });
    seeded.push({ threadId, messageId: id, mailboxId, sentAt: at(day) });
  }
  const visible = seeded
    .filter((s) => s.mailboxId !== hidden.id)
    .toSorted(
      (a, b) => b.sentAt.getTime() - a.sentAt.getTime() || (a.threadId < b.threadId ? 1 : -1),
    );

  const scoped = forMember(db, member);
  const paged: string[] = [];
  let before: { lastMessageAt: Date; id: string } | undefined;
  for (;;) {
    const page = await scoped.listThreads({ limit: 2, before });
    if (page.length === 0) break;
    expect(page.length).toBeLessThanOrEqual(2);
    paged.push(...page.map((t) => t.id));
    const last = page.at(-1)!;
    before = { lastMessageAt: last.lastMessageAt, id: last.id };
  }
  expect(paged).toEqual(visible.map((s) => s.threadId));

  // Thread ids are UUIDv7 in creation order, and so are message ids here: same tie order.
  const hits = await scoped.search("walrus", { limit: 3 });
  expect(hits.map((h) => h.messageId)).toEqual(visible.slice(0, 3).map((s) => s.messageId));
});

test("a domain locks to the first org whose challenge verifies, once, and only owners and admins see it", async () => {
  const orgA = await createOrg(db, "domains-a");
  const orgB = await createOrg(db, "domains-b");
  const owner = await createMember(db, orgA.id, "domain-owner");
  await db.update(members).set({ role: "owner" }).where(eq(members.id, owner.id));
  const plain = await createMember(db, orgA.id, "domain-member");
  const outsider = await createMember(db, orgB.id, "domain-outsider");
  await db.update(members).set({ role: "owner" }).where(eq(members.id, outsider.id));

  const claimFor = (orgId: string, memberId: string, domain = "claimed.test") =>
    openClaim(db, {
      orgId,
      domain,
      memberId,
      challengeHash: `hash-${orgId}-${domain}`,
      provider: "imap",
      dnsRecords: [],
    });
  const a = await claimFor(orgA.id, owner.id);
  const b = await claimFor(orgB.id, outsider.id);
  if (!("claim" in a) || !("claim" in b)) throw new Error("claims refused");
  // Both may wait on the same domain: a pending claim blocks nobody.
  expect([a.created, b.created]).toEqual([true, true]);
  // Claiming again keeps the challenge already handed out.
  expect(await claimFor(orgA.id, owner.id)).toMatchObject({
    created: false,
    claim: { id: a.claim.id, challengeHash: a.claim.challengeHash },
  });

  // Both challenges "verify" at once: exactly one org gets the lock, whatever the timing.
  const results = await Promise.all([lockClaim(db, a.claim), lockClaim(db, b.claim)]);
  const winners = results.filter((r) => r.ok && r.locked);
  expect(winners).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([
    { ok: false, reason: "taken", by: "claimed.test" },
  ]);
  const locks = await db.select().from(mailDomains).where(eq(mailDomains.domain, "claimed.test"));
  expect(locks).toHaveLength(1);
  const winner =
    locks[0]!.orgId === orgA.id ? { org: orgA, claim: a.claim } : { org: orgB, claim: b.claim };
  const loser = winner.org === orgA ? orgB : orgA;
  // A repeat by the winner is a no-op that still reads as success.
  expect(await lockClaim(db, winner.claim)).toMatchObject({ ok: true, locked: false });

  // The lock covers subdomains for everyone else, not for the org that holds it.
  expect(await conflictingLock(db, loser.id, "mail.claimed.test")).toEqual({
    domain: "claimed.test",
    orgId: winner.org.id,
  });
  expect(await conflictingLock(db, winner.org.id, "mail.claimed.test")).toBeNull();

  // Visible to the holding org's owners and admins only.
  const ownerSees = (await listMemberDomains(db, owner.id)).map((d) => d.claim?.domain);
  expect(ownerSees).toEqual(["claimed.test"]);
  expect(await findMemberDomain(db, owner.id, a.claim.id)).toMatchObject({
    claim: { id: a.claim.id },
  });
  expect(await listMemberDomains(db, plain.id)).toEqual([]);
  expect(await findMemberDomain(db, plain.id, a.claim.id)).toBeNull();
  expect(await findMemberDomain(db, outsider.id, a.claim.id)).toBeNull();

  // Lost DNS is reported once per change, and never removes the lock.
  const state = (ok: boolean) =>
    recordChallengeState(db, { orgId: winner.org.id, domain: "claimed.test", ok });
  expect([await state(false), await state(false), await state(true), await state(true)]).toEqual([
    "lost",
    null,
    "restored",
    null,
  ]);

  // Hand-overs: refused while the org has a mailbox on the domain, then move or free it.
  const box = await createMailbox(db, winner.org.id, "hello@claimed.test");
  expect(
    await transferDomain(db, {
      fromOrgId: winner.org.id,
      toOrgId: loser.id,
      domain: "claimed.test",
    }),
  ).toEqual({ ok: false, reason: "has_mailboxes" });
  await db.delete(schemaMailboxes).where(eq(schemaMailboxes.id, box.id));
  expect(
    await transferDomain(db, {
      fromOrgId: winner.org.id,
      toOrgId: loser.id,
      domain: "claimed.test",
    }),
  ).toEqual({ ok: true });
  const [moved] = await db.select().from(mailDomains).where(eq(mailDomains.domain, "claimed.test"));
  expect(moved!.orgId).toBe(loser.id);
  expect(await releaseDomain(db, { orgId: winner.org.id, domain: "claimed.test" })).toEqual({
    ok: false,
    reason: "not_locked",
  });
  expect(await releaseDomain(db, { orgId: loser.id, domain: "claimed.test" })).toEqual({
    ok: true,
  });
  expect(await db.select().from(mailDomains).where(eq(mailDomains.domain, "claimed.test"))).toEqual(
    [],
  );
});

test("pending claims are capped per org and an expired one can no longer lock", async () => {
  const org = await createOrg(db, "domains-cap");
  const admin = await createMember(db, org.id, "cap-admin");
  const open = (domain: string, now?: Date) =>
    openClaim(db, {
      orgId: org.id,
      domain,
      memberId: admin.id,
      challengeHash: `hash-${domain}`,
      provider: "imap",
      dnsRecords: [],
      now,
    });
  // Opened eight days ago: past its week, so it does not count and cannot verify.
  const stale = await open("stale.test", new Date(Date.now() - 8 * 24 * 60 * 60_000));
  if (!("claim" in stale)) throw new Error("refused");
  expect(await lockClaim(db, stale.claim)).toEqual({ ok: false, reason: "expired" });
  expect(await db.select().from(mailDomains).where(eq(mailDomains.domain, "stale.test"))).toEqual(
    [],
  );

  const opened = await Promise.all(
    Array.from({ length: MAX_PENDING_CLAIMS + 2 }, (_, i) => open(`cap-${i}.test`)),
  );
  // Concurrent adds cannot slip past the cap together.
  expect(opened.filter((r) => "claim" in r)).toHaveLength(MAX_PENDING_CLAIMS);
  expect(opened.filter((r) => "error" in r)).toEqual([{ error: "cap" }, { error: "cap" }]);
  // The expired claim renews with a new expiry, but only once there is room under the cap.
  expect(await open("stale.test")).toEqual({ error: "cap" });
});

import { and, eq } from "drizzle-orm";
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
import { applyAgentReply, applyConversationChange } from "../src/mail/conversations.ts";
import { forMember, forUser } from "../src/for-member.ts";
import {
  attachments as attachmentsTable,
  calendarAttendees,
  calendarCalendars,
  calendarEvents,
  drafts as schemaDrafts,
  mailboxes as schemaMailboxes,
  mailboxFolders,
  mailboxAccess,
  mailDomains,
  meetingsAttendees,
  meetingsGrants,
  meetingsMeetings,
  meetingsNotes,
  meetingsSegments,
  members,
  messageLocations,
  notifications,
  tags as tagsTable,
  threadState,
  threadTags as threadTagsTable,
  threads,
  users as schemaUsers,
} from "../src/schema/index.ts";
import { notifyMemberJoined } from "../src/notifications.ts";
import { raiseStoragePeak } from "../src/storage/billing.ts";
import { listUserWorkspaces } from "../src/workspaces.ts";
import { createThread, enqueueAction, upsertMessage } from "../src/mail/writers.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

async function seedThread(
  orgId: string,
  mailboxId: string,
  text: string,
  triage?: { bucket: "needs_reply" | null; confidence: number; source: "ai" | "person" },
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

describe("workspace notifications", () => {
  test("a new teammate notifies everyone else once, and only inside that workspace", async () => {
    const team = await createOrg(db, "joiners");
    const other = await createOrg(db, "elsewhere");
    const dan = await createMember(db, team.id, "dan");
    const eve = await createMember(db, team.id, "eve");
    const outsider = await createMember(db, other.id, "outsider");
    const frank = await createMember(db, team.id, "frank");

    const joined = { orgId: team.id, userId: frank.userId };
    expect((await notifyMemberJoined(db, joined)).toSorted()).toEqual([dan.id, eve.id].toSorted());
    expect(await notifyMemberJoined(db, joined)).toEqual([]);

    const forDan = await forMember(db, dan.id).listNotifications();
    expect(forDan.unread).toBe(1);
    expect(
      forDan.notifications.map((n) => [n.kind, n.threadId, n.mailboxId, n.actor?.name]),
    ).toEqual([["member_joined", null, null, "frank"]]);
    expect((await forMember(db, frank.id).listNotifications()).notifications).toEqual([]);

    await db.insert(notifications).values({
      orgId: team.id,
      memberId: outsider.id,
      kind: "member_joined",
      actorMemberId: frank.id,
    });
    const forOutsider = await forMember(db, outsider.id).listNotifications();
    expect(forOutsider).toEqual({ notifications: [], unread: 0 });
  });
});

describe("forMember isolation", () => {
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
    expect((await asAlice.getConversation(hello.threadId))?.status).toBe("open");
    expect(await asAlice.getConversation(billing.threadId)).toBeNull();
    const [aliceThread, billingThread] = await Promise.all([
      asAlice.getThread(hello.threadId),
      forMember(db, bob).getThread(billing.threadId),
    ]);
    expect(await asAlice.listTags(aliceThread!.mailboxId)).toEqual([]);
    expect(await asAlice.listTags(billingThread!.mailboxId)).toBeNull();
    expect(
      (await asAlice.mailboxAssignees(aliceThread!.mailboxId))?.map((m) => m.memberId),
    ).toEqual([alice]);
    expect(await asAlice.mailboxAssignees(billingThread!.mailboxId)).toBeNull();
    expect(await asAlice.threadAudience(hello.threadId)).toEqual({
      mailboxId: aliceThread!.mailboxId,
      memberIds: [alice],
    });
    expect(await asAlice.threadAudience(billing.threadId)).toBeNull();
    expect(await asAlice.slaSettings(aliceThread!.mailboxId)).toEqual({
      policies: [],
      businessHours: null,
      autoAssign: false,
    });
    expect(await asAlice.slaSettings(billingThread!.mailboxId)).toBeNull();
    expect(await forMember(db, carol).slaSettings(aliceThread!.mailboxId)).toBeNull();
    const year = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") };
    expect((await asAlice.inboxReport(aliceThread!.mailboxId, year))?.created.count).toBe(1);
    expect(await asAlice.inboxReport(billingThread!.mailboxId, year)).toBeNull();
    expect(await forMember(db, carol).inboxReport(aliceThread!.mailboxId, year)).toBeNull();
    expect(await forMember(db, carol).threadAudience(hello.threadId)).toBeNull();
    expect(
      (await asAlice.listConversations({ mailboxId: aliceThread!.mailboxId, view: "all" })).map(
        (c) => c.id,
      ),
    ).toEqual([hello.threadId]);
    expect(
      await asAlice.listConversations({ mailboxId: billingThread!.mailboxId, view: "all" }),
    ).toEqual([]);
    expect((await asAlice.conversationCounts()).map((c) => c.mailboxId)).toEqual([
      aliceThread!.mailboxId,
    ]);
    expect(await asAlice.search("flamingo")).toEqual([]);
    expect(await asAlice.search("albatross")).toEqual([]);

    expect((await forMember(db, bob).search("flamingo")).map((h) => h.messageId)).toEqual([
      billing.messageId,
    ]);

    expect(
      (await asAlice.getThreads([billing.threadId, hello.threadId, ops.threadId])).map((t) => t.id),
    ).toEqual([hello.threadId]);
    const everyone = { from: "example.test", participant: "example.test" };
    expect(
      (await asAlice.listThreads({ view: "all", filters: everyone })).map((t) => t.id),
    ).toEqual([hello.threadId]);
    expect(await asAlice.search("flamingo", { filters: everyone })).toEqual([]);
  });

  test("the AI settings list only the tags of shared inboxes the member is on", async () => {
    const [helloBox, billingBox] = await Promise.all([
      forMember(db, alice).getThread(hello.threadId),
      forMember(db, bob).getThread(billing.threadId),
    ]);
    await db.insert(tagsTable).values([
      { orgId: orgAId, mailboxId: helloBox!.mailboxId, name: "Order", description: "Orders" },
      { orgId: orgAId, mailboxId: billingBox!.mailboxId, name: "Refund", description: "Refunds" },
    ]);
    expect(await forMember(db, alice).listSharedInboxTags()).toEqual([
      {
        id: helloBox!.mailboxId,
        address: "hello@a.test",
        tags: [expect.objectContaining({ name: "Order", description: "Orders" })],
      },
    ]);
    expect((await forMember(db, carol).listSharedInboxTags()).map((i) => i.address)).toEqual([
      "ops@b.test",
    ]);
  });

  test("storage: nobody but its owner reaches a member's My files, not an admin and not another org", async () => {
    const team = await createOrg(db, "files-team");
    const elsewhere = await createOrg(db, "files-elsewhere");
    const owner = await createMember(db, team.id, "files-owner");
    const teammate = await createMember(db, team.id, "files-teammate");
    const admin = await createMember(db, team.id, "files-admin");
    const boss = await createMember(db, team.id, "files-boss");
    const outsider = await createMember(db, elsewhere.id, "files-outsider");
    await db.update(members).set({ role: "admin" }).where(eq(members.id, admin.id));
    await db.update(members).set({ role: "owner" }).where(eq(members.id, boss.id));

    const mine = forMember(db, owner.id).storage;
    const folder = await mine.createFolder({ space: "personal" }, "Private");
    if (folder.status !== "ok") throw new Error(folder.status);
    const opened = await mine.openUpload(
      { parentId: folder.node.id },
      { name: "payslip.pdf", size: 4, limitBytes: null },
    );
    if (opened.status !== "ok") throw new Error(opened.status);
    await mine.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "e", size: 4 });
    const file = await mine.completeUpload(opened.upload.id, { limitBytes: null });
    if (file.status !== "ok") throw new Error(file.status);
    const shared = await mine.createFolder({ space: "shared" }, "Team");
    if (shared.status !== "ok") throw new Error(shared.status);
    expect((await mine.file(file.node.id)).status).toBe("ok");
    expect(await mine.history(file.node.id)).toMatchObject({ status: "ok", sessions: [] });
    expect(await mine.contentAt(file.node.id, file.node.contentVersion)).toMatchObject({
      r2Key: expect.any(String),
      versionId: null,
    });
    const comment = await mine.addComment(file.node.id, { body: "salary is wrong" });
    if (comment.status !== "ok") throw new Error(comment.status);
    const commentId = comment.comment.id;
    const contractUpload = await mine.openUpload(
      { parentId: folder.node.id },
      { name: "contract.pdf", size: 4, mimeType: "application/pdf", limitBytes: null },
    );
    if (contractUpload.status !== "ok") throw new Error(contractUpload.status);
    await mine.recordUploadPart(contractUpload.upload.id, { partNumber: 1, etag: "e", size: 4 });
    const contract = await mine.completeUpload(contractUpload.upload.id, { limitBytes: null });
    if (contract.status !== "ok") throw new Error(contract.status);
    const origin = { email: "files-owner@example.test", ip: null, userAgent: null };
    const sent = await mine.sendForSignature(contract.node.id, {
      contentVersion: contract.node.contentVersion,
      sha256: "0".repeat(64),
      signers: [{ email: "client@example.test", name: "Client" }],
      origin,
    });
    if (sent.status !== "ok") throw new Error(sent.status);
    expect(await mine.signatureRequests(contract.node.id)).toMatchObject({
      status: "ok",
      requests: [{ id: sent.request.id }],
    });

    for (const other of [teammate, admin, boss, outsider]) {
      const theirs = forMember(db, other.id).storage;
      expect(await theirs.node(folder.node.id)).toBeNull();
      expect(await theirs.node(file.node.id)).toBeNull();
      expect((await theirs.list({ parentId: folder.node.id })).status).toBe("not_found");
      expect((await theirs.file(file.node.id)).status).toBe("not_found");
      expect((await theirs.history(file.node.id)).status).toBe("not_found");
      expect(await theirs.contentAt(file.node.id, file.node.contentVersion)).toBeNull();
      expect(await theirs.list({ space: "personal" })).toMatchObject({ status: "ok", nodes: [] });
      expect((await theirs.rename(file.node.id, "seen.pdf")).status).toBe("not_found");
      expect((await theirs.move(file.node.id, { space: "personal" })).status).toBe("not_found");
      expect((await theirs.trash(file.node.id)).status).toBe("not_found");
      expect((await theirs.sharing(file.node.id)).status).toBe("not_found");
      expect((await theirs.putGrant(file.node.id, "me@example.test", "viewer")).status).toBe(
        "not_found",
      );
      expect((await theirs.setLinkAccess(folder.node.id, "anyone")).status).toBe("not_found");
      expect(
        (
          await theirs.openUpload(
            { parentId: folder.node.id },
            { name: "planted.txt", size: 1, limitBytes: null },
          )
        ).status,
      ).toBe("not_found");
      expect((await theirs.comments(file.node.id)).status).toBe("not_found");
      expect((await theirs.addComment(file.node.id, { body: "seen" })).status).toBe("not_found");
      expect((await theirs.editComment(file.node.id, commentId, "x")).status).toBe("not_found");
      expect((await theirs.resolveComment(file.node.id, commentId, true)).status).toBe("not_found");
      expect((await theirs.deleteComment(file.node.id, commentId)).status).toBe("not_found");
      expect(await theirs.upload(opened.upload.id)).toBeNull();
      expect((await theirs.completeUpload(opened.upload.id, { limitBytes: null })).status).toBe(
        "not_found",
      );
      expect((await theirs.signatureRequests(contract.node.id)).status).toBe("not_found");
      expect((await theirs.voidSignature(sent.request.id, origin)).status).toBe("not_found");
      expect(
        (
          await theirs.sendForSignature(contract.node.id, {
            contentVersion: contract.node.contentVersion,
            sha256: "1".repeat(64),
            signers: [{ email: "planted@example.test", name: "Planted" }],
            origin,
          })
        ).status,
      ).toBe("not_found");
    }
    expect(await mine.signatureRequests(contract.node.id)).toMatchObject({
      requests: [{ id: sent.request.id, status: "sent" }],
    });

    await mine.trash(file.node.id);
    expect((await forMember(db, admin.id).storage.listTrash()).nodes).toEqual([]);
    expect((await forMember(db, admin.id).storage.restore(file.node.id)).status).toBe("not_found");
    expect((await forMember(db, admin.id).storage.deleteForever(file.node.id)).status).toBe(
      "not_found",
    );
    expect(await forMember(db, teammate.id).storage.list({ space: "shared" })).toMatchObject({
      nodes: [{ id: shared.node.id }],
    });
    expect(await forMember(db, outsider.id).storage.node(shared.node.id)).toBeNull();
    expect(await forMember(db, outsider.id).storage.list({ space: "shared" })).toMatchObject({
      nodes: [],
    });
    expect(await forUser(db, admin.userId).storage.node(folder.node.id)).toBeNull();

    const month = new Date("2026-11-01T00:00:00Z");
    await raiseStoragePeak(db, { orgId: team.id, periodStart: month, bytes: 7_000 });
    expect(await forMember(db, teammate.id).storage.peak(month)).toBe(7_000);
    expect(await forMember(db, outsider.id).storage.peak(month)).toBe(0);
    expect(await forMember(db, "no-such-member").storage.peak(month)).toBeNull();
  });

  test("talk: a pair's thread reaches those two alone, not an admin and not another org", async () => {
    const org = await createOrg(db, "iso-talk");
    const other = await createOrg(db, "iso-talk-other");
    const [ana, ben, admin] = await Promise.all(
      ["ana", "ben", "admin"].map((name) => createMember(db, org.id, name)),
    );
    const outsider = await createMember(db, other.id, "outsider");
    await db.update(members).set({ role: "admin" }).where(eq(members.id, admin!.id));
    const opened = await forMember(db, ana!.id).talk.openThread(ben!.id);
    if (opened.status !== "ok") throw new Error(opened.status);
    const threadId = opened.thread.id;
    const sent = await forMember(db, ana!.id).talk.sendNote(threadId, "between us");
    if (sent.status !== "ok") throw new Error(sent.status);

    for (const id of [admin!.id, outsider.id, "no-such-member"]) {
      const talk = forMember(db, id).talk;
      expect((await talk.thread(threadId)).status).not.toBe("ok");
      expect((await talk.messages(threadId)).status).not.toBe("ok");
      expect((await talk.fileOf(sent.message.id)).status).not.toBe("ok");
      expect((await talk.react(sent.message.id, "👍", true)).status).not.toBe("ok");
      const people = await talk.people();
      const threads = people.status === "ok" ? people.people.map((p) => p.threadId) : [];
      expect(threads).not.toContain(threadId);
    }
    expect((await forMember(db, outsider.id).talk.openThread(ana!.id)).status).toBe("not_found");
  });

  test("a grant that crosses orgs opens nothing", async () => {
    const asCarol = forMember(db, carol);
    expect((await asCarol.listThreads()).map((t) => t.id)).toEqual([ops.threadId]);
    expect((await asCarol.listThreads({ view: "all" })).map((t) => t.id)).toEqual([ops.threadId]);
    expect(await asCarol.getThread(hello.threadId)).toBeNull();
    expect(await asCarol.search("pelican")).toEqual([]);
    expect(await asCarol.setThreadState(hello.threadId, { read: true })).toBeNull();
    expect(await asCarol.getConversation(hello.threadId)).toBeNull();
    const helloBox = (await forMember(db, alice).getThread(hello.threadId))!.mailboxId;
    expect(await asCarol.listTags(helloBox)).toBeNull();
    expect(await asCarol.mailboxAssignees(helloBox)).toBeNull();
    expect(await asCarol.listConversations({ mailboxId: helloBox, view: "all" })).toEqual([]);
    await db.insert(notifications).values({
      orgId: orgBId,
      memberId: carol,
      kind: "mention",
      threadId: hello.threadId,
    });
    expect((await asCarol.listNotifications()).notifications).toEqual([]);
    expect((await asCarol.conversationCounts()).map((c) => c.mailboxId)).toEqual([opsBoxId]);
    expect((await forMember(db, alice).mailboxAssignees(helloBox))?.map((m) => m.memberId)).toEqual(
      [alice],
    );
    expect(
      await applyConversationChange(db, {
        threadId: hello.threadId,
        actorMemberId: carol,
        change: { type: "resolve" },
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  test("the workspace switcher lists only the user's orgs and the mailboxes granted to them there", async () => {
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
    await asBob.setThreadState(billing.threadId, { later: true });
    const [thread] = await asBob.listThreads({ view: "later" });
    expect(thread).toMatchObject({
      read: true,
      later: true,
      deferredUntil: new Date("9999-12-31T00:00:00Z"),
    });

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
    await grant(db, orgX.id, salesBox.id, uy);
    await grant(db, orgZ.id, zBox.id, zed);

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
    const paged: string[] = [];
    let before: { lastMessageAt: Date; id: string } | undefined;
    for (;;) {
      const page = await asUma.listThreads({ view: "all", limit: 1, before });
      if (!page.length) break;
      paged.push(page[0]!.id);
      before = page[0]!;
    }
    expect(paged).toEqual(all.map((t) => t.id));

    for (const id of [xSales, zDesk]) {
      expect(await asUma.getThread(id)).toBeNull();
      expect(await asUma.memberFor(id)).toBeNull();
    }
    expect((await asUma.getThread(yDesk))?.orgId).toBe(orgYId);
  });

  test("search covers every workspace's granted mailboxes and nothing else", async () => {
    const asUma = forUser(db, uma);
    expect((await asUma.search("kestrel")).map((h) => [h.orgId, h.threadId])).toEqual([
      [orgXId, xInbox],
    ]);
    expect((await asUma.search("osprey")).map((h) => [h.orgId, h.threadId])).toEqual([
      [orgYId, yDesk],
    ]);
    expect(await asUma.search("condor")).toEqual([]);
    expect(await asUma.search("vulture")).toEqual([]);
    expect((await forMember(db, ux).search("osprey")).map((h) => h.threadId)).toEqual([]);
  });

  test("state and counts are each workspace member's own, and a thread names its member", async () => {
    const asUma = forUser(db, uma);
    expect((await asUma.memberFor(xInbox))?.id).toBe(ux);
    expect((await asUma.memberFor(yDesk))?.id).toBe(uy);

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

test("Later hides the thread from the member's inbox, only theirs, until they move it back", async () => {
  const org = await createOrg(db, "snooze-org");
  const dana = (await createMember(db, org.id, "dana")).id;
  const erin = (await createMember(db, org.id, "erin")).id;
  const shared = await createMailbox(db, org.id, "team@snooze.test");
  await grant(db, org.id, shared.id, dana);
  await grant(db, org.id, shared.id, erin);
  const { threadId } = await seedThread(org.id, shared.id, "heron");
  const ids = async (member: string, view: "inbox" | "later") =>
    (await forMember(db, member).listThreads({ view })).map((t) => t.id);

  await forMember(db, dana).setThreadState(threadId, { later: true });
  expect(await ids(dana, "inbox")).toEqual([]);
  expect(await ids(dana, "later")).toEqual([threadId]);
  expect(await ids(erin, "inbox")).toEqual([threadId]);
  expect(await forMember(db, dana).counts()).toMatchObject([{ inbox: 0, unread: 0, later: 1 }]);
  expect(await forMember(db, erin).counts()).toMatchObject([{ inbox: 1, unread: 1, later: 0 }]);

  await forMember(db, dana).setThreadState(threadId, { later: false });
  expect(await ids(dana, "inbox")).toEqual([threadId]);
  expect(await ids(dana, "later")).toEqual([]);
});

test("a shared conversation stays in each teammate's Inbox until they mark it done", async () => {
  const org = await createOrg(db, "shared-done-org");
  const dana = (await createMember(db, org.id, "dana")).id;
  const erin = (await createMember(db, org.id, "erin")).id;
  const team = await createMailbox(db, org.id, "help@shared-done.test");
  for (const member of [dana, erin]) await grant(db, org.id, team.id, member);
  const change = (
    threadId: string,
    actor: string,
    c: Parameters<typeof applyConversationChange>[1]["change"],
  ) => applyConversationChange(db, { threadId, actorMemberId: actor, change: c });

  const unowned = (await seedThread(org.id, team.id, "unowned")).threadId;
  const erins = (await seedThread(org.id, team.id, "erins")).threadId;
  const answered = (await seedThread(org.id, team.id, "answered")).threadId;
  const snoozed = (await seedThread(org.id, team.id, "snoozed")).threadId;
  expect(await change(erins, erin, { type: "assign", memberId: erin })).toMatchObject({ ok: true });
  expect(await applyAgentReply(db, { threadId: answered, memberId: erin })).toMatchObject({
    ok: true,
  });
  expect(
    await change(snoozed, erin, { type: "snooze", until: new Date(Date.now() + 86_400_000) }),
  ).toMatchObject({ ok: true });

  const inbox = async (member: string) =>
    (await forMember(db, member).listThreads({ view: "inbox" })).map((t) => t.id).sort();
  const inboxCount = async (member: string) =>
    (await forMember(db, member).counts()).find((c) => c.mailboxId === team.id)?.inbox ?? 0;
  const all = [unowned, erins, answered, snoozed].sort();

  expect(await inbox(dana)).toEqual(all);
  expect(await inbox(erin)).toEqual(all);
  expect(await inboxCount(dana)).toBe(4);

  for (const id of [erins, answered]) {
    await forMember(db, erin).setThreadState(id, { doneThrough: new Date("2026-10-01T00:00:00Z") });
  }
  expect(await inbox(erin)).toEqual([unowned, snoozed].sort());
  expect(await inbox(dana)).toEqual(all);
  expect(await inboxCount(erin)).toBe(2);
  expect(await inboxCount(dana)).toBe(4);

  const rows = await db
    .select({ id: threads.id, status: threads.status, assignee: threads.assigneeMemberId })
    .from(threads)
    .where(eq(threads.mailboxId, team.id));
  expect(rows.find((r) => r.id === erins)).toMatchObject({ status: "open", assignee: erin });
  expect(rows.find((r) => r.id === answered)).toMatchObject({ status: "pending", assignee: erin });

  await forMember(db, dana).setThreadState(unowned, { later: true });
  expect(await inbox(dana)).toEqual([answered, erins, snoozed].sort());
  expect(await inbox(erin)).toEqual([unowned, snoozed].sort());
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

test("Sent, Trash and Spam list the threads filed in that folder, and the newest threads feed search", async () => {
  const org = await createOrg(db, "folders-org");
  const member = (await createMember(db, org.id, "erin")).id;
  const box = await createMailbox(db, org.id, "erin@folders.test");
  await grant(db, org.id, box.id, member);
  const filed: Record<string, string> = {};
  let uid = 1;
  for (const role of ["inbox", "sent", "trash", "junk"] as const) {
    const [folder] = await db
      .insert(mailboxFolders)
      .values({ orgId: org.id, mailboxId: box.id, path: role, role, uidvalidity: 1 })
      .returning({ id: mailboxFolders.id });
    const { threadId, messageId } = await seedThread(org.id, box.id, `${role} mail`);
    await db.insert(messageLocations).values({
      orgId: org.id,
      mailboxId: box.id,
      folderId: folder!.id,
      imapUid: uid++,
      messageId,
    });
    filed[role] = threadId;
  }

  const reads = forMember(db, member);
  const ids = async (view: "sent" | "trash" | "spam") =>
    (await reads.listThreads({ view })).map((t) => t.id);
  expect(await ids("sent")).toEqual([filed.sent]);
  expect(await ids("trash")).toEqual([filed.trash]);
  expect(await ids("spam")).toEqual([filed.junk]);

  const recent = await reads.searchRecent({ limit: 10 });
  expect(recent.map((h) => h.threadId).toSorted()).toEqual(Object.values(filed).toSorted());
  expect(recent[0]).toMatchObject({ mailboxAddress: "erin@folders.test", messageCount: 1 });
  expect(recent[0]!.excerpt).toMatch(/^Please look at the \w+ mail details\.$/);
  const other = await createOrg(db, "folders-other");
  const outsider = (await createMember(db, other.id, "eve")).id;
  expect(await forMember(db, outsider).searchRecent({ limit: 10 })).toEqual([]);
});

test("lanes split AI triage at the auto-file confidence; person triage always files; no lane stays out", async () => {
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
  await seedThread(org.id, box.id, "no lane", { bucket: null, confidence: 0.95, source: "ai" });
  const fallback = await seedThread(org.id, box.id, "fallback", {
    bucket: null,
    confidence: 0,
    source: "ai",
  });

  const scoped = forMember(db, member);
  const ids = async (lane: "needs_reply" | "unsure") =>
    (await scoped.listThreads({ lane })).map((t) => t.id).toSorted();
  expect(await ids("needs_reply")).toEqual([sure.threadId, person.threadId].toSorted());
  expect(await ids("unsure")).toEqual([unsure.threadId, fallback.threadId].toSorted());
});

test("thread pages and search merge granted mailboxes newest first, each row once, ties included", async () => {
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
  expect([a.created, b.created]).toEqual([true, true]);
  expect(await claimFor(orgA.id, owner.id)).toMatchObject({
    created: false,
    claim: { id: a.claim.id, challengeHash: a.claim.challengeHash },
  });

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
  expect(await lockClaim(db, winner.claim)).toMatchObject({ ok: true, locked: false });

  expect(await conflictingLock(db, loser.id, "mail.claimed.test")).toEqual({
    domain: "claimed.test",
    orgId: winner.org.id,
  });
  expect(await conflictingLock(db, winner.org.id, "mail.claimed.test")).toBeNull();

  const ownerSees = (await listMemberDomains(db, owner.id)).map((d) => d.claim?.domain);
  expect(ownerSees).toEqual(["claimed.test"]);
  expect(await findMemberDomain(db, owner.id, a.claim.id)).toMatchObject({
    claim: { id: a.claim.id },
  });
  expect(await listMemberDomains(db, plain.id)).toEqual([]);
  expect(await findMemberDomain(db, plain.id, a.claim.id)).toBeNull();
  expect(await findMemberDomain(db, outsider.id, a.claim.id)).toBeNull();

  const state = (ok: boolean) =>
    recordChallengeState(db, { orgId: winner.org.id, domain: "claimed.test", ok });
  expect([await state(false), await state(false), await state(true), await state(true)]).toEqual([
    "lost",
    null,
    "restored",
    null,
  ]);

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
  const stale = await open("stale.test", new Date(Date.now() - 8 * 24 * 60 * 60_000));
  if (!("claim" in stale)) throw new Error("refused");
  expect(await lockClaim(db, stale.claim)).toEqual({ ok: false, reason: "expired" });
  expect(await db.select().from(mailDomains).where(eq(mailDomains.domain, "stale.test"))).toEqual(
    [],
  );

  const opened = await Promise.all(
    Array.from({ length: MAX_PENDING_CLAIMS + 2 }, (_, i) => open(`cap-${i}.test`)),
  );
  expect(opened.filter((r) => "claim" in r)).toHaveLength(MAX_PENDING_CLAIMS);
  expect(opened.filter((r) => "error" in r)).toEqual([{ error: "cap" }, { error: "cap" }]);
  expect(await open("stale.test")).toEqual({ error: "cap" });
});

test("google accounts: only personal Gmail the grantees can see, scoped sessions only in scope", async () => {
  const personal = await createOrg(db, `personal-${Date.now()}`);
  const company = await createOrg(db, `company-${Date.now()}`);
  const dan = await createMember(db, personal.id, "dan");
  const [danAtCompany] = await db
    .insert(members)
    .values({
      id: crypto.randomUUID(),
      organizationId: company.id,
      userId: dan.userId,
      createdAt: new Date(),
    })
    .returning();
  const eve = await createMember(db, company.id, "eve");
  const gmail = async (
    orgId: string,
    address: string,
    kind: "personal" | "shared" = "personal",
  ) => {
    const [row] = await db
      .insert(schemaMailboxes)
      .values({ orgId, address, kind, provider: "gmail", credentialsEnc: "x" })
      .returning();
    return row!;
  };
  const mine = await gmail(personal.id, "dan@gmail.test");
  const work = await gmail(company.id, "dan@company.test");
  const evesBox = await gmail(company.id, "eve@company.test");
  const sharedBox = await gmail(company.id, "team@company.test", "shared");
  await grant(db, personal.id, mine.id, dan.id);
  await grant(db, company.id, work.id, danAtCompany!.id);
  await grant(db, company.id, evesBox.id, eve.id);
  await grant(db, company.id, sharedBox.id, danAtCompany!.id);
  await grant(db, company.id, evesBox.id, dan.id);

  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  expect(ids(await forUser(db, dan.userId).googleAccounts())).toEqual([mine.id, work.id].sort());
  expect(await forUser(db, dan.userId).googleAccounts()).toContainEqual(
    expect.objectContaining({ id: mine.id, orgId: personal.id, memberId: dan.id }),
  );
  expect(ids(await forUser(db, dan.userId, company.id).googleAccounts())).toEqual([work.id]);
  expect(ids(await forMember(db, dan.id).googleAccounts())).toEqual([mine.id]);
  expect(ids(await forUser(db, eve.userId).googleAccounts())).toEqual([evesBox.id]);

  expect(ids(await forUser(db, dan.userId).listMailboxes())).toEqual(
    [mine.id, work.id, sharedBox.id].sort(),
  );
  expect(ids(await forUser(db, dan.userId, company.id).listMailboxes())).toEqual(
    [work.id, sharedBox.id].sort(),
  );
  expect(await forUser(db, dan.userId).memberForMailbox(work.id)).toMatchObject({
    id: danAtCompany!.id,
    orgId: company.id,
  });
  expect(await forUser(db, dan.userId).memberForMailbox(evesBox.id)).toBeNull();
  expect(await forUser(db, dan.userId, company.id).memberForMailbox(mine.id)).toBeNull();

  const draftIn = async (mailboxId: string, orgId: string) => {
    const [row] = await db
      .insert(schemaDrafts)
      .values({ orgId, mailboxId, kind: "new" })
      .returning();
    return row!.id;
  };
  expect(
    await forUser(db, dan.userId).memberForResource("draft", await draftIn(work.id, company.id)),
  ).toMatchObject({ id: danAtCompany!.id });
  const evesDraft = await draftIn(evesBox.id, company.id);
  expect(await forUser(db, dan.userId).memberForResource("draft", evesDraft)).toBeNull();
  expect(await forUser(db, dan.userId).memberForResource("action", "no-such-action")).toBeNull();
});

test("thread filters match by sender, participant, dates, attachments, mine, status and tag", async () => {
  const org = await createOrg(db, "filters");
  const member = (await createMember(db, org.id, "fiona")).id;
  const box = await createMailbox(db, org.id, "fiona@acme.test");
  await grant(db, org.id, box.id, member);
  const seed = async (subject: string, message: Partial<Parameters<typeof upsertMessage>[1]>) => {
    const sentAt = message.sentAt ?? new Date("2026-10-10T12:00:00Z");
    const threadId = await createThread(db, {
      orgId: org.id,
      mailboxId: box.id,
      subjectKey: subject,
      lastMessageAt: sentAt,
    });
    const stored = await upsertMessage(db, {
      orgId: org.id,
      mailboxId: box.id,
      threadId,
      messageIdHeader: `<${threadId}@filters.test>`,
      subject,
      fromAddress: "someone@else.test",
      sentAt,
      cleanText: `${subject} walrus`,
      ...message,
    });
    return { threadId, messageId: stored.id };
  };
  const stripe = await seed("receipt", { fromAddress: "billing@mail.stripe.com" });
  const lookalike = await seed("phish", { fromAddress: "billing@notstripe.com" });
  const cc = await seed("cc'd", { cc: [{ name: null, address: "ops@stripe.com" }] });
  const early = await seed("early", { sentAt: new Date("2026-09-01T00:00:00Z") });
  const mine = await seed("sent", { fromAddress: "Fiona@acme.test" });
  await db.insert(attachmentsTable).values({
    orgId: org.id,
    messageId: early.messageId,
    filename: "a.pdf",
    mimeType: "application/pdf",
    size: 10,
    r2Key: "k",
  });
  await db.update(threads).set({ status: "resolved" }).where(eq(threads.id, cc.threadId));
  const [tag] = await db
    .insert(tagsTable)
    .values({ orgId: org.id, mailboxId: box.id, name: "VIP" })
    .returning();
  await db
    .insert(threadTagsTable)
    .values({ orgId: org.id, threadId: mine.threadId, tagId: tag!.id });

  const reads = forMember(db, member);
  const list = async (filters: Parameters<typeof reads.listThreads>[0]) =>
    (await reads.listThreads({ view: "all", ...filters })).map((t) => t.id).sort();
  const ids = (...threads: { threadId: string }[]) => threads.map((t) => t.threadId).sort();

  expect(await list({ filters: { from: "stripe.com" } })).toEqual(ids(stripe));
  expect(await list({ filters: { from: "billing@notstripe.com" } })).toEqual(ids(lookalike));
  expect(await list({ filters: { participant: "stripe.com" } })).toEqual(ids(stripe, cc));
  expect(await list({ filters: { before: new Date("2026-10-01T00:00:00Z") } })).toEqual(ids(early));
  expect(
    await list({ filters: { after: new Date("2026-10-10T12:00:00Z"), from: "else.test" } }),
  ).toEqual(ids(cc));
  expect(await list({ filters: { hasAttachments: true } })).toEqual(ids(early));
  expect(await list({ filters: { fromMe: true } })).toEqual(ids(mine));
  expect(await list({ filters: { status: "resolved" } })).toEqual(ids(cc));
  expect(await list({ filters: { tag: "vip" } })).toEqual(ids(mine));
  expect(
    (await reads.search("walrus", { filters: { from: "stripe.com" } })).map((h) => h.threadId),
  ).toEqual([stripe.threadId]);
});

test("meetings find: only meetings the member can open, in their own workspace, whoever is granted elsewhere", async () => {
  const t = crypto.randomUUID().slice(0, 8);
  const home = await createOrg(db, `find-home-${t}`);
  const away = await createOrg(db, `find-away-${t}`);
  const address = `dana-${t}@studio.test`;
  const [user] = await db
    .insert(schemaUsers)
    .values({ id: crypto.randomUUID(), name: "Dana", email: address, emailVerified: true })
    .returning();
  const join = async (orgId: string, userId: string, role = "member") => {
    const [row] = await db
      .insert(members)
      .values({
        id: crypto.randomUUID(),
        organizationId: orgId,
        userId,
        role,
        createdAt: new Date(),
      })
      .returning();
    return row!;
  };
  const dana = await join(home.id, user!.id);
  await join(away.id, user!.id);
  const teammate = async (role = "member") => {
    const [u] = await db
      .insert(schemaUsers)
      .values({
        id: crypto.randomUUID(),
        name: role,
        email: `${role}-${crypto.randomUUID().slice(0, 8)}@studio.test`,
        emailVerified: true,
      })
      .returning();
    return join(home.id, u!.id, role);
  };
  const ben = await teammate();
  const fran = await teammate("freelancer");

  const meeting = async (orgId: string, text: string, attendee: string, recordedBy?: string) => {
    const [row] = await db
      .insert(meetingsMeetings)
      .values({
        orgId,
        title: text,
        groupKey: "domain:client.test",
        recordedByMemberId: recordedBy ?? null,
        consentAt: new Date(),
        status: "ready",
      })
      .returning();
    await db
      .insert(meetingsSegments)
      .values({ meetingId: row!.id, orgId, seq: 0, startMs: 0, endMs: 1000, text });
    await db
      .insert(meetingsAttendees)
      .values({ meetingId: row!.id, orgId, address: `a-${t}@client.test`, name: attendee });
    return row!.id;
  };
  const mine = await meeting(home.id, `presupuesto ${t}`, "Mary_Jane", dana.id);
  const lookalike = await meeting(home.id, `presupuesto ${t}`, "MaryXJane", dana.id);
  const granted = await meeting(away.id, `presupuesto ${t}`, "Mary_Jane");
  await db
    .insert(meetingsGrants)
    .values({ meetingId: granted, orgId: away.id, address, role: "viewer" });

  const ids = async (
    memberId: string,
    filter: Parameters<ReturnType<typeof forMember>["meetings"]["find"]>[0],
  ) => {
    const found = await forMember(db, memberId).meetings.find(filter);
    return found.status === "ok" ? found.meetings.map((m) => m.id).toSorted() : found.status;
  };
  expect(await ids(dana.id, { words: `presupuesto ${t}` })).toEqual([mine, lookalike].toSorted());
  expect(await ids(dana.id, { people: ["mary_jane"] })).toEqual([mine]);
  expect(await ids(ben.id, { words: `presupuesto ${t}` })).toEqual([]);
  expect(await ids(ben.id, {})).toEqual([]);
  expect(await ids(fran.id, {})).toEqual([]);

  await db
    .update(meetingsMeetings)
    .set({ access: "workspace" })
    .where(eq(meetingsMeetings.id, mine));
  expect(await ids(ben.id, { people: ["mary_jane"] })).toEqual([mine]);
  expect(await ids(fran.id, {})).toEqual([]);
});

test("calendar occurrences: an event by row or UID, and the one on now, only from calendars the member opens in their own workspace", async () => {
  const t = crypto.randomUUID().slice(0, 8);
  const home = await createOrg(db, `occ-home-${t}`);
  const away = await createOrg(db, `occ-away-${t}`);
  const ana = await createMember(db, home.id, `ana-${t}`);
  const ben = await createMember(db, home.id, `ben-${t}`);
  const eve = await createMember(db, away.id, `eve-${t}`);
  const box = await createMailbox(db, home.id, `hello-${t}@studio.test`);
  await grant(db, home.id, box.id, ana.id);
  await grant(db, home.id, box.id, eve.id);
  const [calendar] = await db
    .insert(calendarCalendars)
    .values({ orgId: home.id, mailboxId: box.id })
    .returning();
  const now = Date.now();
  const uid = `call-${t}@example.test`;
  const [event] = await db
    .insert(calendarEvents)
    .values({
      orgId: home.id,
      calendarId: calendar!.id,
      uid,
      source: "omni",
      title: "Client call",
      conferenceUrl: "https://meet.example.test/abc",
      startsAt: new Date(now - 60_000),
      endsAt: new Date(now + 30 * 60_000),
    })
    .returning();
  await db.insert(calendarAttendees).values({
    eventId: event!.id,
    orgId: home.id,
    address: `marta-${t}@client.test`,
    role: "required",
    response: "accepted",
  });

  const anaCalendar = forMember(db, ana.id).calendar;
  expect(await anaCalendar.occurrence({ id: event!.id }, null)).toMatchObject({
    status: "ok",
    event: { uid, title: "Client call" },
  });
  expect(await anaCalendar.occurrence({ uid }, null)).toMatchObject({ status: "ok" });
  expect((await anaCalendar.occurrenceAt(new Date(now)))?.uid).toBe(uid);

  for (const outsider of [ben.id, eve.id]) {
    const door = forMember(db, outsider).calendar;
    expect(await door.occurrence({ id: event!.id }, null)).toEqual({ status: "not_found" });
    expect(await door.occurrence({ uid }, null)).toEqual({ status: "not_found" });
    expect(await door.occurrenceAt(new Date(now))).toBeNull();
  }
});

test("booking links: only their owner lists or changes them, and only while the owner can open the calendar", async () => {
  const t = crypto.randomUUID().slice(0, 8);
  const home = await createOrg(db, `book-home-${t}`);
  const away = await createOrg(db, `book-away-${t}`);
  const ana = await createMember(db, home.id, `ana-${t}`);
  const ben = await createMember(db, home.id, `ben-${t}`);
  const eve = await createMember(db, away.id, `eve-${t}`);
  const box = await createMailbox(db, home.id, `hello-${t}@studio.test`);
  await grant(db, home.id, box.id, ana.id);
  await grant(db, home.id, box.id, ben.id);
  await grant(db, home.id, box.id, eve.id);
  const [calendar] = await db
    .insert(calendarCalendars)
    .values({ orgId: home.id, mailboxId: box.id })
    .returning();
  const anaDoor = forMember(db, ana.id).calendar;
  const made = await anaDoor.createBookingLink({
    calendarId: calendar!.id,
    title: "Intro call",
    durationMinutes: 30,
    timeZone: "UTC",
  });
  if (made.status !== "ok") throw new Error(made.status);
  expect((await anaDoor.bookingLinks()).map((l) => l.id)).toEqual([made.link.id]);

  for (const outsider of [ben.id, eve.id]) {
    const door = forMember(db, outsider).calendar;
    expect(await door.bookingLinks()).toEqual([]);
    expect(await door.updateBookingLink(made.link.id, { title: "Mine" })).toEqual({
      status: "not_found",
    });
    expect(await door.deleteBookingLink(made.link.id)).toEqual({ status: "not_found" });
  }
  expect(
    await forMember(db, eve.id).calendar.createBookingLink({
      calendarId: calendar!.id,
      title: "Across",
      durationMinutes: 30,
      timeZone: "UTC",
    }),
  ).toEqual({ status: "not_found" });

  await db
    .delete(mailboxAccess)
    .where(and(eq(mailboxAccess.mailboxId, box.id), eq(mailboxAccess.memberId, ana.id)));
  expect(await anaDoor.bookingLinks()).toEqual([]);
  expect(await anaDoor.updateBookingLink(made.link.id, { title: "Still mine" })).toEqual({
    status: "not_found",
  });
});

test("meetings Ask sources: only notes and transcripts of meetings the member can open, in their own workspace", async () => {
  const t = crypto.randomUUID().slice(0, 8);
  const home = await createOrg(db, `ask-home-${t}`);
  const away = await createOrg(db, `ask-away-${t}`);
  const person = async (name: string) => {
    const [u] = await db
      .insert(schemaUsers)
      .values({
        id: crypto.randomUUID(),
        name,
        email: `${name}-${t}@studio.test`,
        emailVerified: true,
      })
      .returning();
    return u!;
  };
  const join = async (orgId: string, userId: string, role = "member") => {
    const [row] = await db
      .insert(members)
      .values({
        id: crypto.randomUUID(),
        organizationId: orgId,
        userId,
        role,
        createdAt: new Date(),
      })
      .returning();
    return row!;
  };
  const danaUser = await person("dana");
  const dana = await join(home.id, danaUser.id);
  await join(away.id, danaUser.id);
  const ben = await join(home.id, (await person("ben")).id);
  const fran = await join(home.id, (await person("fran")).id, "freelancer");
  const group = `domain:client-${t}.test`;

  const meeting = async (orgId: string, words: string, recordedBy: string | null) => {
    const [row] = await db
      .insert(meetingsMeetings)
      .values({
        orgId,
        title: words,
        groupKey: group,
        recordedByMemberId: recordedBy,
        consentAt: new Date(),
        status: "ready",
      })
      .returning();
    await db
      .insert(meetingsSegments)
      .values({ meetingId: row!.id, orgId, seq: 0, startMs: 0, endMs: 1000, text: words });
    await db.insert(meetingsNotes).values({
      meetingId: row!.id,
      orgId,
      summary: `summary of ${words}`,
      highlights: [],
      topics: [],
      model: "test",
      promptVersion: 1,
    });
    return row!.id;
  };
  const mine = await meeting(home.id, `launch date ${t}`, dana.id);
  const elsewhere = await meeting(away.id, `launch secret ${t}`, null);
  await db
    .insert(meetingsGrants)
    .values({ meetingId: elsewhere, orgId: away.id, address: danaUser.email, role: "viewer" });

  const sources = async (memberId: string) => {
    const found = await forMember(db, memberId).meetings.groupAskSources(group, `launch ${t}`);
    return found.status === "ok"
      ? found.meetings.map((m) => [m.id, m.transcript?.turns.map((x) => x.text) ?? null])
      : found.status;
  };
  expect(await sources(dana.id)).toEqual([[mine, [`launch date ${t}`]]]);
  expect(await sources(ben.id)).toBe("not_found");
  expect(await sources(fran.id)).toBe("not_found");
  const one = async (memberId: string, meetingId: string) =>
    (await forMember(db, memberId).meetings.askSources(meetingId)).status;
  expect(await one(dana.id, elsewhere)).toBe("not_found");
  expect(await one(ben.id, mine)).toBe("not_found");

  await db
    .update(meetingsMeetings)
    .set({ access: "workspace" })
    .where(eq(meetingsMeetings.id, mine));
  expect(await sources(ben.id)).toEqual([[mine, [`launch date ${t}`]]]);
  expect(await one(ben.id, mine)).toBe("ok");
  expect(await sources(fran.id)).toBe("not_found");
  expect(await one(fran.id, mine)).toBe("not_found");
});

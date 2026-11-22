import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { members, storageNodes } from "../src/schema/index.ts";
import { createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function team(slug: string) {
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  const cy = await createMember(db, org.id, "cy");
  return { org, ana, ben, cy };
}

test("a third teammate, even the workspace's owner, never reaches a pair's thread", async () => {
  const { ana, ben, cy } = await team("talk-third");
  await setRole(db, cy.id, "owner");
  const thread = ok(await forMember(db, ana.id).talk.openThread(ben.id)).thread;
  const note = ok(await forMember(db, ana.id).talk.sendNote(thread.id, "the deck is up")).message;
  const owner = forMember(db, cy.id).talk;

  expect((await owner.thread(thread.id)).status).toBe("not_found");
  expect((await owner.messages(thread.id)).status).toBe("not_found");
  expect((await owner.sendNote(thread.id, "me too")).status).toBe("not_found");
  expect((await owner.read(thread.id)).status).toBe("not_found");
  expect((await owner.react(note.id, "👍", true)).status).toBe("not_found");
  expect(
    (await owner.recordFile(thread.id, { nodeId: "x", name: "a.txt", size: 1, mimeType: null }))
      .status,
  ).toBe("not_found");
  const people = ok(await owner.people()).people;
  expect(people.map((p) => [p.threadId, p.unread])).toEqual([
    [null, 0],
    [null, 0],
  ]);
  const seen = ok(await forMember(db, ben.id).talk.messages(thread.id)).messages;
  expect(seen.map((m) => m.body)).toEqual(["the deck is up"]);
});

test("a member of another workspace can neither open a thread with us nor read ours", async () => {
  const { ana, ben } = await team("talk-ours");
  const other = await createOrg(db, "talk-theirs");
  const eve = forMember(db, (await createMember(db, other.id, "eve")).id).talk;
  const thread = ok(await forMember(db, ana.id).talk.openThread(ben.id)).thread;

  expect((await eve.openThread(ana.id)).status).toBe("not_found");
  expect((await forMember(db, ana.id).talk.openThread(ben.id)).status).toBe("ok");
  expect((await eve.messages(thread.id)).status).toBe("not_found");
  expect((await eve.sendNote(thread.id, "hi")).status).toBe("not_found");
  expect(ok(await eve.people()).people).toEqual([]);
});

test("freelancers and Personal spaces have no Talk, and a freelancer is nobody's teammate", async () => {
  const { ana, cy } = await team("talk-freelancer");
  await setRole(db, cy.id, "freelancer");
  const freelancer = forMember(db, cy.id).talk;
  expect((await freelancer.people()).status).toBe("no_talk");
  expect((await freelancer.openThread(ana.id)).status).toBe("no_talk");
  expect((await forMember(db, ana.id).talk.openThread(cy.id)).status).toBe("not_found");
  const listed = ok(await forMember(db, ana.id).talk.people()).people.map((p) => p.memberId);
  expect(listed).not.toContain(cy.id);

  const solo = await createPerson(db, "solo@talk-personal.test");
  const orgId = await ensurePersonalSpace(db, solo.id);
  const [member] = await db.select().from(members).where(eq(members.organizationId, orgId));
  expect((await forMember(db, member!.id).talk.people()).status).toBe("no_talk");
});

test("a pair has one thread, whoever opens it first and however often", async () => {
  const { ana, ben } = await team("talk-pair");
  const [first, second, third] = await Promise.all([
    forMember(db, ana.id).talk.openThread(ben.id),
    forMember(db, ben.id).talk.openThread(ana.id),
    forMember(db, ana.id).talk.openThread(ben.id),
  ]);
  const ids = new Set([ok(first).thread.id, ok(second).thread.id, ok(third).thread.id]);
  expect(ids.size).toBe(1);
  expect([first, second, third].filter((r) => ok(r).created)).toHaveLength(1);
  expect((await forMember(db, ana.id).talk.openThread(ana.id)).status).toBe("not_found");
});

test("unread counts the other one's notes since you last read, never your own", async () => {
  const { ana, ben } = await team("talk-unread");
  const anaTalk = forMember(db, ana.id).talk;
  const benTalk = forMember(db, ben.id).talk;
  const thread = ok(await anaTalk.openThread(ben.id)).thread;
  ok(await anaTalk.sendNote(thread.id, "one"));
  ok(await anaTalk.sendNote(thread.id, "two"));
  const unreadFor = async (talk: typeof anaTalk, other: string) =>
    ok(await talk.people()).people.find((p) => p.memberId === other)?.unread;

  expect(await unreadFor(benTalk, ana.id)).toBe(2);
  expect(await unreadFor(anaTalk, ben.id)).toBe(0);
  ok(await benTalk.read(thread.id));
  expect(await unreadFor(benTalk, ana.id)).toBe(0);
  ok(await anaTalk.sendNote(thread.id, "three"));
  expect(await unreadFor(benTalk, ana.id)).toBe(1);
});

test("notes page newest first, carry their reactions, and refuse what is not text or an emoji", async () => {
  const { ana, ben } = await team("talk-page");
  const anaTalk = forMember(db, ana.id).talk;
  const thread = ok(await anaTalk.openThread(ben.id)).thread;
  for (const body of ["a", "b", "c"]) ok(await anaTalk.sendNote(thread.id, body));
  const first = ok(await anaTalk.messages(thread.id, { limit: 2 }));
  expect(first.messages.map((m) => m.body)).toEqual(["c", "b"]);
  expect(first.more).toBe(true);
  const rest = ok(await anaTalk.messages(thread.id, { before: first.messages[1]!.id }));
  expect(rest.messages.map((m) => m.body)).toEqual(["a"]);
  expect(rest.more).toBe(false);

  const c = first.messages[0]!;
  ok(await forMember(db, ben.id).talk.react(c.id, "🔥", true));
  ok(await forMember(db, ben.id).talk.react(c.id, "🔥", true));
  ok(await anaTalk.react(c.id, "🔥", true));
  const reacted = ok(await anaTalk.messages(thread.id, { limit: 1 })).messages[0]!;
  expect(reacted.reactions).toEqual([{ emoji: "🔥", memberIds: [ben.id, ana.id] }]);
  ok(await anaTalk.react(c.id, "🔥", false));
  const after = ok(await anaTalk.messages(thread.id, { limit: 1 })).messages[0]!;
  expect(after.reactions).toEqual([{ emoji: "🔥", memberIds: [ben.id] }]);

  expect((await anaTalk.sendNote(thread.id, "   ")).status).toBe("invalid_body");
  expect((await anaTalk.sendNote(thread.id, "x".repeat(4001))).status).toBe("invalid_body");
  expect((await anaTalk.react(c.id, "ok", true)).status).toBe("invalid_emoji");
  ok(await anaTalk.react(c.id, "🇧🇷", true));
  ok(await anaTalk.react(c.id, "1️⃣", true));
  expect((await anaTalk.react(c.id, "👍👍", true)).status).toBe("invalid_emoji");
});

test("a file's note keeps what was sent after the file is deleted for good", async () => {
  const { org, ana, ben } = await team("talk-file");
  const [node] = await db
    .insert(storageNodes)
    .values({
      orgId: org.id,
      space: "personal",
      ownerMemberId: ana.id,
      kind: "file",
      name: "brief.pdf",
      size: 2048,
      mimeType: "application/pdf",
      r2Key: `orgs/${org.id}/talk-file`,
    })
    .returning();
  const anaTalk = forMember(db, ana.id).talk;
  const thread = ok(await anaTalk.openThread(ben.id)).thread;
  const file = { nodeId: node!.id, name: "brief.pdf", size: 2048, mimeType: "application/pdf" };
  ok(await anaTalk.recordFile(thread.id, file));
  await db.delete(storageNodes).where(eq(storageNodes.id, node!.id));

  const [message] = ok(await forMember(db, ben.id).talk.messages(thread.id)).messages;
  expect(message!.file).toEqual({ ...file, nodeId: null });
  expect(message!.body).toBeNull();
});

test("removing a member takes their threads with them", async () => {
  const { ana, ben } = await team("talk-leaver");
  const thread = ok(await forMember(db, ana.id).talk.openThread(ben.id)).thread;
  ok(await forMember(db, ana.id).talk.sendNote(thread.id, "bye"));
  await db.delete(members).where(eq(members.id, ben.id));
  expect((await forMember(db, ana.id).talk.messages(thread.id)).status).toBe("not_found");
  expect(ok(await forMember(db, ana.id).talk.people()).people).toHaveLength(1);
});

test("a note still sending when the other one reads stays unread for them", async () => {
  const { ana, ben } = await team("talk-race");
  const thread = ok(await forMember(db, ana.id).talk.openThread(ben.id)).thread;
  const sending = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const sent = db.transaction(async (tx) => {
    const note = await forMember(tx as unknown as typeof db, ana.id).talk.sendNote(
      thread.id,
      "in flight",
    );
    written.resolve();
    await sending.promise;
    return note;
  });
  await written.promise;
  ok(await forMember(db, ben.id).talk.read(thread.id));
  sending.resolve();
  ok(await sent);
  const people = ok(await forMember(db, ben.id).talk.people()).people;
  expect(people.find((p) => p.memberId === ana.id)?.unread).toBe(1);
});

test("one person's reactions on a note stop at eight, even sent all at once", async () => {
  const { ana, ben } = await team("talk-cap");
  const thread = ok(await forMember(db, ana.id).talk.openThread(ben.id)).thread;
  const note = ok(await forMember(db, ana.id).talk.sendNote(thread.id, "react")).message;
  const emoji = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎"];
  await Promise.all(emoji.map((e) => forMember(db, ben.id).talk.react(note.id, e, true)));
  const [shown] = ok(await forMember(db, ben.id).talk.messages(thread.id)).messages;
  expect(shown!.reactions).toHaveLength(8);
});

test("when both react to a note at once, the higher version of its reactions has both", async () => {
  const { ana, ben } = await team("talk-react-race");
  const thread = ok(await forMember(db, ana.id).talk.openThread(ben.id)).thread;
  for (let i = 0; i < 10; i++) {
    const note = ok(await forMember(db, ana.id).talk.sendNote(thread.id, `race ${i}`)).message;
    const done = await Promise.all([
      forMember(db, ana.id).talk.react(note.id, "👍", true),
      forMember(db, ben.id).talk.react(note.id, "🎉", true),
    ]);
    const [latest] = done.map(ok).toSorted((a, b) => b.reactionsVersion - a.reactionsVersion);
    expect(latest!.reactions.map((r) => r.emoji).toSorted()).toEqual(["🎉", "👍"]);
  }
});

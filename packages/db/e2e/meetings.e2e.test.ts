import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { meetingsPipeline } from "../src/meetings.ts";
import { members, users } from "../src/schema/index.ts";
import { setRole } from "./storage-support.ts";
import { createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function person(address: string) {
  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), name: address.split("@")[0]!, email: address, emailVerified: true })
    .returning();
  return user!;
}

async function memberOf(orgId: string, address: string, role = "member") {
  const user = await person(address);
  const [member] = await db
    .insert(members)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId: user.id,
      role,
      createdAt: new Date(),
    })
    .returning();
  return { ...member!, address, userId: user.id };
}

const tag = () => randomUUID().slice(0, 8);

async function studio() {
  const t = tag();
  const org = await createOrg(db, `meet-${t}`);
  const dana = await memberOf(org.id, `dana-${t}@studio.test`);
  const ben = await memberOf(org.id, `ben-${t}@studio.test`);
  const cy = await memberOf(org.id, `cy-${t}@studio.test`);
  const fran = await memberOf(org.id, `fran-${t}@studio.test`, "freelancer");
  const client = await person(`marta-${t}@client.test`);
  return { t, org, dana, ben, cy, fran, client: { ...client, address: client.email } };
}

async function record(
  memberId: string,
  input: { attendees: string[]; event?: { uid: string; recurrenceId: string | null } | null },
) {
  return forMember(db, memberId).meetings.start({
    title: "Kickoff",
    event: input.event ?? null,
    attendees: input.attendees.map((address) => ({ address, name: null })),
    groupKey: null,
    consent: true,
  });
}

test("only the recorder and attendees open a meeting; an uninvited teammate, even an owner, does not", async () => {
  const s = await studio();
  await setRole(db, s.cy.id, "owner");
  const { meetingId } = ok(await record(s.dana.id, { attendees: [s.dana.address, s.ben.address] }));
  await meetingsPipeline(db).saveTranscript(meetingId, s.org.id, {
    language: "en",
    durationMs: 1000,
    rawNodeId: null,
    turns: [{ speaker: "A", startMs: 0, endMs: 900, text: "the budget is forty thousand" }],
    speakers: [{ label: "A", name: null, address: null, source: null, confidence: 0 }],
  });

  expect(ok(await forMember(db, s.dana.id).meetings.get(meetingId)).role).toBe("owner");
  expect(ok(await forMember(db, s.ben.id).meetings.get(meetingId)).role).toBe("viewer");

  const owner = forMember(db, s.cy.id).meetings;
  expect((await owner.get(meetingId)).status).toBe("not_found");
  expect((await owner.transcript(meetingId)).status).toBe("not_found");
  expect((await owner.change(meetingId, { access: "workspace" })).status).toBe("not_found");
  expect((await owner.grant(meetingId, s.cy.address, "editor")).status).toBe("not_found");
  expect((await owner.remove(meetingId)).status).toBe("not_found");
  expect(ok(await owner.list()).meetings).toEqual([]);
  expect(ok(await owner.groups()).groups).toEqual([]);
  expect(ok(await owner.search("budget")).hits).toEqual([]);
  expect(ok(await forMember(db, s.ben.id).meetings.search("budget")).hits).toHaveLength(1);
});

test("attendees outside the workspace and freelancers open it through their grant, read only", async () => {
  const s = await studio();
  const { meetingId } = ok(
    await record(s.dana.id, { attendees: [s.dana.address, s.client.address, s.fran.address] }),
  );

  const outside = forUser(db, s.client.id).meetings;
  expect(ok(await outside.get(meetingId)).role).toBe("viewer");
  expect(ok(await outside.list()).meetings.map((m) => m.id)).toEqual([meetingId]);
  expect(ok(await outside.get(meetingId)).sharing).toBeNull();

  const fran = forMember(db, s.fran.id).meetings;
  expect(ok(await fran.get(meetingId)).role).toBe("viewer");
  expect((await fran.change(meetingId, { title: "mine" })).status).toBe("forbidden");
  expect((await fran.grant(meetingId, "someone@else.test", "viewer")).status).toBe("forbidden");
  expect((await fran.renameSpeaker(meetingId, "A", { name: "X", address: null })).status).toBe(
    "forbidden",
  );
  expect((await fran.remove(meetingId)).status).toBe("forbidden");
});

test("workspace access opens it to teammates, never to a freelancer who was not invited", async () => {
  const s = await studio();
  const { meetingId } = ok(await record(s.dana.id, { attendees: [s.dana.address] }));
  ok(await forMember(db, s.dana.id).meetings.change(meetingId, { access: "workspace" }));

  expect(ok(await forMember(db, s.cy.id).meetings.get(meetingId)).role).toBe("viewer");
  expect((await forMember(db, s.fran.id).meetings.get(meetingId)).status).toBe("not_found");
  expect((await forUser(db, s.client.id).meetings.get(meetingId)).status).toBe("not_found");
});

test("removing a grant, an attendee's too, closes the meeting at once; the owner's cannot be removed", async () => {
  const s = await studio();
  const { meetingId } = ok(await record(s.dana.id, { attendees: [s.dana.address, s.ben.address] }));
  const dana = forMember(db, s.dana.id).meetings;

  ok(await dana.grant(meetingId, s.cy.address, "editor"));
  expect(ok(await forMember(db, s.cy.id).meetings.get(meetingId)).role).toBe("editor");
  ok(await forMember(db, s.cy.id).meetings.revoke(meetingId, s.ben.address));
  expect((await forMember(db, s.ben.id).meetings.get(meetingId)).status).toBe("not_found");

  ok(await forMember(db, s.cy.id).meetings.revoke(meetingId, s.dana.address));
  expect((await dana.grant(meetingId, s.dana.address, "viewer")).status).toBe("forbidden");
  expect(ok(await dana.get(meetingId)).role).toBe("owner");
});

test("a member of another workspace reaches nothing through the member door, even with a grant", async () => {
  const s = await studio();
  const other = await createOrg(db, `meet-other-${s.t}`);
  const eve = await memberOf(other.id, `eve-${s.t}@else.test`);
  const { meetingId } = ok(await record(s.dana.id, { attendees: [s.dana.address, eve.address] }));

  expect((await forMember(db, eve.id).meetings.get(meetingId)).status).toBe("not_found");
  expect(ok(await forMember(db, eve.id).meetings.list()).meetings).toEqual([]);
  expect(ok(await forUser(db, eve.userId).meetings.get(meetingId)).role).toBe("viewer");
  expect((await forUser(db, eve.userId, other.id).meetings.get(meetingId)).status).toBe(
    "not_found",
  );
});

test("a calendar meeting is recorded once: a second start while it records is refused, after it is the next part", async () => {
  const s = await studio();
  const event = { uid: `uid-${s.t}`, recurrenceId: null };
  const first = ok(await record(s.dana.id, { attendees: [s.dana.address, s.ben.address], event }));

  const again = await record(s.ben.id, { attendees: [s.dana.address, s.ben.address], event });
  expect(again).toEqual({
    status: "recording_elsewhere",
    meetingId: first.meetingId,
    recordedByMemberId: s.dana.id,
  });

  const racing = await Promise.all([
    record(s.cy.id, { attendees: [], event: { uid: `race-${s.t}`, recurrenceId: "2026-11-23" } }),
    record(s.ben.id, { attendees: [], event: { uid: `race-${s.t}`, recurrenceId: "2026-11-23" } }),
  ]);
  expect(racing.filter((r) => r.status === "ok")).toHaveLength(1);

  await meetingsPipeline(db).stopRecording(first.meetingId, {
    endedAt: new Date(),
    durationMs: 1000,
    audioNodeId: null as unknown as string,
    micSpans: null,
    cuts: [],
  });
  const second = ok(await record(s.ben.id, { attendees: [s.ben.address], event }));
  expect(second.part).toBe(2);
});

test("a group summary is made and cached only from the meetings its reader can open", async () => {
  const s = await studio();
  const pipeline = meetingsPipeline(db);
  const groupKey = `domain:client-${s.t}.test`;
  const make = async (memberId: string, attendees: string[], summary: string) => {
    const { meetingId } = ok(
      await forMember(db, memberId).meetings.start({
        title: summary,
        event: null,
        attendees: attendees.map((address) => ({ address, name: null })),
        groupKey,
        consent: true,
      }),
    );
    await pipeline.saveNotes(meetingId, s.org.id, {
      title: null,
      summary,
      highlights: [],
      topics: [],
      actions: [],
      model: "test",
      promptVersion: 1,
    });
    return meetingId;
  };
  await make(s.dana.id, [s.dana.address, s.ben.address], "shared call");
  await make(s.dana.id, [s.dana.address], "private pricing call");

  const ben = ok(await forMember(db, s.ben.id).meetings.groupDigest(groupKey));
  const dana = ok(await forMember(db, s.dana.id).meetings.groupDigest(groupKey));
  expect(ben.meetings.map((m) => m.summary)).toEqual(["shared call"]);
  expect(dana.meetings).toHaveLength(2);
  expect(ben.meetingsHash).not.toBe(dana.meetingsHash);

  await pipeline.saveGroupSummary(
    s.org.id,
    groupKey,
    dana.meetingsHash!,
    "pricing too",
    new Date(),
  );
  expect(ok(await forMember(db, s.ben.id).meetings.groupDigest(groupKey)).cached).toBeNull();
  expect(ok(await forMember(db, s.dana.id).meetings.groupDigest(groupKey)).cached?.summary).toBe(
    "pricing too",
  );
});

test("a retried pipeline keeps a person's rename, one set of actions, and writes the doc once", async () => {
  const s = await studio();
  const pipeline = meetingsPipeline(db);
  const { meetingId } = ok(await record(s.dana.id, { attendees: [s.dana.address] }));
  const transcript = {
    language: "es",
    durationMs: 2000,
    rawNodeId: null,
    turns: [
      { speaker: "A", startMs: 0, endMs: 900, text: "hola" },
      { speaker: "B", startMs: 1000, endMs: 1900, text: "claro" },
    ],
    speakers: [
      { label: "A", name: "Dana", address: s.dana.address, source: "mic" as const, confidence: 1 },
      { label: "B", name: null, address: null, source: null, confidence: 0 },
    ],
  };
  const notes = {
    title: null,
    summary: "s",
    highlights: [],
    topics: [],
    actions: [{ kind: "task" as const, payload: { title: "send deck" } }],
    model: "test",
    promptVersion: 1,
  };

  await pipeline.saveTranscript(meetingId, s.org.id, transcript);
  ok(
    await forMember(db, s.dana.id).meetings.renameSpeaker(meetingId, "B", {
      name: "Marta",
      address: null,
    }),
  );
  await pipeline.saveTranscript(meetingId, s.org.id, transcript);
  await pipeline.nameSpeakers(meetingId, [
    { label: "B", name: "Wrong", address: null, confidence: 0.5 },
  ]);
  await pipeline.saveNotes(meetingId, s.org.id, notes);
  await pipeline.saveNotes(meetingId, s.org.id, notes);

  const meeting = ok(await forMember(db, s.dana.id).meetings.get(meetingId));
  expect(meeting.speakers.find((sp) => sp.label === "B")).toMatchObject({
    name: "Marta",
    source: "person",
  });
  expect(meeting.actions).toHaveLength(1);
  expect(meeting.meeting.status).toBe("ready");
  expect(ok(await forMember(db, s.dana.id).meetings.transcript(meetingId)).segments).toHaveLength(
    2,
  );
  expect(await pipeline.claimDocWrite(meetingId)).toBe(true);
  expect(await pipeline.claimDocWrite(meetingId)).toBe(false);

  const [action] = meeting.actions;
  ok(
    await forMember(db, s.dana.id).meetings.decideAction(action!.id, {
      accept: true,
      taskId: "t1",
    }),
  );
  expect(
    (await forMember(db, s.dana.id).meetings.decideAction(action!.id, { accept: false })).status,
  ).toBe("decided");
});

test("starting without consent is refused", async () => {
  const s = await studio();
  const refused = await forMember(db, s.dana.id).meetings.start({
    title: null,
    event: null,
    attendees: [],
    groupKey: null,
    consent: false,
  });
  expect(refused.status).toBe("consent_required");
});

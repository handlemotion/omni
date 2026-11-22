import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startMeetingsStack, type MeetingsStack } from "./meetings-support.ts";

let m: MeetingsStack;
beforeAll(async () => {
  m = await startMeetingsStack();
}, 120_000);
afterAll(() => m?.stop());

const prompts = (kind: string, from: number) =>
  m.calls.slice(from).filter((call) => call.kind === kind);

test("a group's summary and Ask read only the meetings their reader can open", async () => {
  const org = await m.stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await m.stack.member(org.id);
  const ben = await m.stack.member(org.id);
  const cy = await m.stack.member(org.id);
  const marta = { address: "marta@client.test", name: "Marta Gil" };
  const group = encodeURIComponent("domain:client.test");

  const kickoff = await m.record(dana, {
    title: "Kickoff with Ben",
    attendees: [marta, { address: ben.email, name: "Ben" }],
  });
  let from = m.calls.length;
  const first = await m.api(dana, "GET", `/groups/${group}`);
  expect(first.status).toBe(200);
  expect(first.body.summary).toMatch(/December 4/);
  expect(prompts("group", from)).toHaveLength(1);

  const pricing = await m.record(dana, { title: "Pricing without Ben", attendees: [marta] });
  from = m.calls.length;
  const refreshed = await m.api(dana, "GET", `/groups/${group}`);
  expect(refreshed.body.meetings.map((x: { id: string }) => x.id)).toEqual([
    pricing.meetingId,
    kickoff.meetingId,
  ]);
  const [both] = prompts("group", from);
  expect(both?.user).toContain("Pricing without Ben");
  expect(both?.user).toContain("Kickoff with Ben");

  from = m.calls.length;
  expect((await m.api(dana, "GET", `/groups/${group}`)).body.summary).toBe(refreshed.body.summary);
  const bens = await m.api(ben, "GET", `/groups/${group}`);
  expect(bens.body.meetings.map((x: { id: string }) => x.id)).toEqual([kickoff.meetingId]);
  expect(
    bens.body.timeline.every((h: { meetingId: string }) => h.meetingId === kickoff.meetingId),
  ).toBe(true);
  expect(bens.body.summary).toBe(first.body.summary);
  expect(prompts("group", from)).toHaveLength(0);

  from = m.calls.length;
  const answer = await m.api(ben, "POST", "/ask", {
    groupKey: "domain:client.test",
    question: "¿Cuándo es el lanzamiento y de qué depende el deploy?",
  });
  expect(answer.status).toBe(200);
  expect(answer.body.answer).toContain("[1]");
  expect(answer.body.citations.length).toBeGreaterThan(0);
  for (const c of answer.body.citations) expect(c.meetingId).toBe(kickoff.meetingId);
  const [asked] = prompts("ask", from);
  expect(asked?.user).toContain("Kickoff with Ben");
  expect(asked?.user).toContain("Transcript:");
  expect(asked?.user).not.toContain("Pricing without Ben");
  expect(asked?.user.match(/^## Meeting /gm)).toHaveLength(1);

  from = m.calls.length;
  const one = { meetingId: pricing.meetingId, question: "¿Cuándo es el lanzamiento?" };
  expect((await m.api(ben, "POST", "/ask", one)).status).toBe(404);
  expect((await m.api(cy, "POST", "/ask", { ...one, meetingId: kickoff.meetingId })).status).toBe(
    404,
  );
  const cys = await m.api(cy, "POST", "/ask", { groupKey: "domain:client.test", question: "x" });
  expect(cys.status).toBe(404);
  expect((await m.api(cy, "GET", `/groups/${group}`)).body).toMatchObject({
    summary: null,
    meetings: [],
  });
  expect(m.calls.length).toBe(from);

  const own = await m.api(dana, "POST", "/ask", one);
  expect(own.status).toBe(200);
  expect(own.body.citations.map((c: { meetingId: string }) => c.meetingId)).toContain(
    pricing.meetingId,
  );
  expect(
    (await m.api(dana, "POST", "/ask", { ...one, groupKey: "domain:client.test" })).status,
  ).toBe(400);
});

/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers */
import { forMember, schema } from "@omni/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack, type Person } from "./crm-support.ts";

let stack: CrmStack;
beforeAll(async () => {
  stack = await startCrmStack({ vars: { TRANSCRIBE_PROVIDER: "assemblyai" } });
}, 60_000);
afterAll(() => stack?.stop());

async function meetingsApi(person: Person, method: string, path: string) {
  const response = await fetch(new URL(`/api/meetings${path}`, stack.worker.url), {
    method,
    headers: { cookie: person.jar.header },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function recorded(memberId: string, title: string, attendees: string[]) {
  const started = await forMember(stack.db, memberId).meetings.start({
    title,
    event: null,
    attendees: attendees.map((address) => ({ address, name: null })),
    consent: true,
  });
  if (started.status !== "ok") throw new Error(started.status);
  return started.meetingId;
}

async function project() {
  const t = crypto.randomUUID().slice(0, 8);
  const org = await stack.company(`crm-meet-${t}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const domain = `acme-${t}.test`;
  const carla = await stack.api(dana.jar, "POST", "/people", {
    name: "Carla",
    address: `carla@${domain}`,
  });
  expect(carla.status).toBe(201);
  const { id: personId, companyId } = carla.body.person;
  const deal = await stack.api(dana.jar, "POST", "/deals", {
    name: "Website",
    companyId,
    personIds: [personId],
  });
  expect(deal.status).toBe(201);
  return { org, dana, ben, domain, personId, companyId, dealId: deal.body.deal.id as string };
}

const titles = (list: { title: string }[]) => list.map((m) => m.title);
const timelineMeetings = (body: any) =>
  body.items.filter((i: any) => i.kind === "meeting").map((i: any) => i.meeting.title);

test("a project's Meetings tab has its people's and its company's meetings and the ones put on it; taking one off leaves it on the person", async () => {
  const p = await project();
  await recorded(p.dana.id, "With Carla", [p.dana.email, `carla@${p.domain}`]);
  await recorded(p.dana.id, "With Lee", [`lee@${p.domain}`]);
  const prep = await recorded(p.dana.id, "Internal prep", [p.dana.email]);
  await recorded(p.dana.id, "Unrelated", ["someone@else.test"]);

  const put = await stack.api(p.dana.jar, "PUT", `/deals/${p.dealId}/meetings/${prep}`);
  expect(put.status).toBe(204);
  const tab = await stack.api(p.dana.jar, "GET", `/deals/${p.dealId}/meetings`);
  expect(tab.status).toBe(200);
  expect(titles(tab.body.meetings)).toEqual(["Internal prep", "With Lee", "With Carla"]);
  expect(tab.body.meetings[0]).toMatchObject({ placed: true, openActions: 0, summary: null });

  const benTab = await stack.api(p.ben.jar, "GET", `/deals/${p.dealId}/meetings`);
  expect(benTab.body.meetings).toEqual([]);
  expect((await stack.api(p.ben.jar, "PUT", `/deals/${p.dealId}/meetings/${prep}`)).status).toBe(
    404,
  );

  const withCarla = tab.body.meetings.find((m: any) => m.title === "With Carla").id;
  expect(
    (await stack.api(p.dana.jar, "DELETE", `/deals/${p.dealId}/meetings/${withCarla}`)).status,
  ).toBe(204);
  const after = await stack.api(p.dana.jar, "GET", `/deals/${p.dealId}/meetings`);
  expect(titles(after.body.meetings)).toEqual(["Internal prep", "With Lee"]);
  const dealTimeline = await stack.api(p.dana.jar, "GET", `/deals/${p.dealId}/timeline`);
  expect(timelineMeetings(dealTimeline.body)).toEqual(["Internal prep", "With Lee"]);

  const person = await stack.api(p.dana.jar, "GET", `/people/${p.personId}/timeline`);
  expect(timelineMeetings(person.body)).toEqual(["With Carla"]);
  const company = await stack.api(p.dana.jar, "GET", `/companies/${p.companyId}/timeline`);
  expect(timelineMeetings(company.body)).toEqual(["With Lee", "With Carla"]);

  const paged = await stack.api(p.dana.jar, "GET", `/deals/${p.dealId}/meetings?limit=1`);
  expect(titles(paged.body.meetings)).toEqual(["Internal prep"]);
  const rest = await stack.api(
    p.dana.jar,
    "GET",
    `/deals/${p.dealId}/meetings?limit=1&cursor=${paged.body.nextCursor}`,
  );
  expect(titles(rest.body.meetings)).toEqual(["With Lee"]);
});

test("a meeting's task accepted into the calendar finds its meeting, only for who can open it", async () => {
  const p = await project();
  const meetingId = await recorded(p.dana.id, "Kickoff", [p.dana.email]);
  const [action] = await stack.db
    .insert(schema.meetingsActions)
    .values({
      meetingId,
      orgId: p.org.id,
      seq: 0,
      kind: "task",
      payload: { title: "Send the brief" },
    })
    .returning();
  const accepted = await meetingsApi(p.dana, "POST", `/actions/${action!.id}/accept`);
  expect(accepted.status).toBe(200);
  const taskId = accepted.body.action.taskId as string;
  expect(taskId).toBeTruthy();

  const found = await meetingsApi(p.dana, "GET", `/tasks/${taskId}`);
  expect(found).toMatchObject({
    status: 200,
    body: { actionId: action!.id, meeting: { id: meetingId, title: "Kickoff" } },
  });
  expect((await meetingsApi(p.ben, "GET", `/tasks/${taskId}`)).status).toBe(404);
});

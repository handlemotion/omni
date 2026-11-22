import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startMeetingsStack, type MeetingsStack } from "./meetings-support.ts";

let m: MeetingsStack;
beforeAll(async () => {
  m = await startMeetingsStack();
}, 120_000);
afterAll(() => m?.stop());

const company = () => m.stack.company(`meetings-${randomUUID().slice(0, 8)}`);

test("an outside attendee opens the meeting shared with them, and loses it when the grant goes", async () => {
  const studio = await company();
  const dana = await m.stack.member(studio.id);
  const client = await m.stack.member((await company()).id);
  const stranger = await m.stack.member((await company()).id);

  const { meetingId } = await m.record(dana, {
    title: "Entregas sitio web",
    attendees: [{ address: client.email, name: "Marta Gil" }],
  });

  const opened = await m.api(client, "GET", `/shared/${meetingId}`);
  expect(opened.status).toBe(200);
  expect(opened.body).toMatchObject({ role: "viewer", sharing: null });
  expect(opened.body.meeting).toMatchObject({ id: meetingId, status: "ready" });
  expect(opened.body.notes.summary).toMatch(/acceso/i);
  expect(
    (await m.api(client, "GET", `/shared/${meetingId}/transcript`)).body.segments,
  ).toHaveLength(6);
  const audio = await fetch(
    new URL(`/api/meetings/shared/${meetingId}/audio`, m.stack.worker.url),
    {
      headers: { cookie: client.jar.header },
    },
  );
  expect(audio.status).toBe(200);
  expect((await audio.arrayBuffer()).byteLength).toBe(64);
  expect(
    (await m.api(client, "GET", "/shared")).body.meetings.map((x: { id: string }) => x.id),
  ).toEqual([meetingId]);
  const asked = await m.api(client, "POST", "/shared/ask", {
    meetingId,
    question: "¿Cuándo es el lanzamiento?",
  });
  expect(asked.status).toBe(200);
  expect(asked.body.citations[0]).toMatchObject({ meetingId });

  expect((await m.api(client, "GET", `/${meetingId}`)).status).toBe(404);
  for (const path of [
    `/shared/${meetingId}`,
    `/shared/${meetingId}/transcript`,
    `/shared/${meetingId}/audio`,
  ]) {
    expect((await m.api(stranger, "GET", path)).status).toBe(404);
  }
  expect((await m.api(stranger, "POST", "/shared/ask", { meetingId, question: "x" })).status).toBe(
    404,
  );
  expect((await m.api(stranger, "GET", "/shared")).body.meetings).toEqual([]);
  expect((await m.api(null, "GET", `/shared/${meetingId}`)).status).toBe(401);

  const revoked = await m.api(
    dana,
    "DELETE",
    `/${meetingId}/grants/${encodeURIComponent(client.email)}`,
  );
  expect(revoked.status).toBe(204);
  expect((await m.api(client, "GET", `/shared/${meetingId}`)).status).toBe(404);
  expect((await m.api(client, "GET", `/shared/${meetingId}/audio`)).status).toBe(404);
  expect((await m.api(client, "GET", "/shared")).body.meetings).toEqual([]);
  expect((await m.api(dana, "GET", `/shared/${meetingId}`)).status).toBe(404);
  expect((await m.api(dana, "GET", "/shared")).body.meetings).toEqual([]);
});

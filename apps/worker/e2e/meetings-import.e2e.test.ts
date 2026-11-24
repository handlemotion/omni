/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startMeetingsStack, type MeetingsStack } from "./meetings-support.ts";

let m: MeetingsStack;
beforeAll(async () => {
  m = await startMeetingsStack();
}, 120_000);
afterAll(() => m?.stop());

const circleback = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/meetings/circleback-cooperativa-es.json", import.meta.url),
    "utf8",
  ),
) as any;

const workspace = async () => {
  const org = await m.stack.company(`import-${randomUUID().slice(0, 8)}`);
  return { org, lucia: await m.stack.member(org.id) };
};

test("a Circleback meeting is filed ready, with its transcript, speakers, notes and actions, and no engine or model call", async () => {
  const { lucia } = await workspace();
  const calls = m.calls.length;
  const imported = await m.api(lucia, "POST", "/import", circleback);
  expect(imported.status).toBe(201);
  const { meetingId } = imported.body;

  const got = await m.api(lucia, "GET", `/${meetingId}`);
  expect(got.status).toBe(200);
  expect(got.body.meeting).toMatchObject({
    title: "Cooperativa : Café de altura",
    status: "ready",
    startedAt: "2026-11-19T17:27:34.826Z",
    durationMs: 312_500,
    recordedByMemberId: lucia.id,
  });
  expect(got.body.notes.summary).toBe(
    "La fundación entrevistó a la cooperativa para documentar su alianza con la cadena de restaurantes. La cooperativa vende cerca del 80% de su café a un solo cliente.",
  );
  expect(got.body.notes.chapters.map((c: any) => [c.title, c.startMs])).toEqual([
    ["Financiamiento", 61_000],
    ["Certificaciones", 190_000],
  ]);
  expect(got.body.actions.map((a: any) => [a.payload.title, a.payload.owner, a.state])).toEqual([
    ["Compartir los resultados del estudio con la cooperativa", "Lucía Romero", "open"],
    ["Enviar el cuestionario", null, "done"],
  ]);
  expect(got.body.speakers.map((s: any) => [s.label, s.name, s.address]).toSorted()).toEqual([
    ["Lucía Romero", "Lucía Romero", "lucia@fundacion.test"],
    ["Participant 3", null, null],
  ]);

  const transcript = await m.api(lucia, "GET", `/${meetingId}/transcript`);
  expect(transcript.body.segments).toHaveLength(6);
  expect(transcript.body.segments.at(-1)).toMatchObject({
    speaker: "Participant 3",
    startMs: 193_400,
    endMs: 312_500,
  });
  expect((await m.api(lucia, "GET", `/${meetingId}/audio`)).status).toBe(404);

  expect(m.calls.length).toBe(calls);
});

test("importing the same Circleback meeting again, even twice at once, keeps one meeting", async () => {
  const { org, lucia } = await workspace();
  const [a, b] = await Promise.all([
    m.api(lucia, "POST", "/import", circleback),
    m.api(lucia, "POST", "/import", { ...circleback, name: "Renamed in Circleback" }),
  ]);
  expect([a.status, b.status].toSorted()).toEqual([200, 201]);
  expect(a.body.meetingId).toBe(b.body.meetingId);
  const again = await m.api(lucia, "POST", "/import", circleback);
  expect(again).toMatchObject({
    status: 200,
    body: { meetingId: a.body.meetingId, created: false },
  });
  const rows = await m.stack.db
    .select({ id: schema.meetingsMeetings.id })
    .from(schema.meetingsMeetings)
    .where(eq(schema.meetingsMeetings.orgId, org.id));
  expect(rows).toHaveLength(1);

  const other = await workspace();
  const elsewhere = await m.api(other.lucia, "POST", "/import", circleback);
  expect(elsewhere.status).toBe(201);
  expect(elsewhere.body.meetingId).not.toBe(a.body.meetingId);
});

test("an import without a Circleback id or start is refused", async () => {
  const { lucia } = await workspace();
  const { id: _id, ...noId } = circleback;
  expect((await m.api(lucia, "POST", "/import", noId)).status).toBe(400);
  expect(
    (await m.api(lucia, "POST", "/import", { ...circleback, createdAt: "yesterday" })).status,
  ).toBe(400);
  expect((await m.api(null, "POST", "/import", circleback)).status).toBe(401);
});

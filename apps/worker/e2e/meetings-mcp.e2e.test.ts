/* oxlint-disable typescript/no-explicit-any -- test reads of tool answers and engine fixtures */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Client } from "@modelcontextprotocol/client";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { createMailbox, grant, WEB_ORIGIN } from "./support.ts";

const fixtures = new URL("../../../fixtures/meetings/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, fixtures), "utf8")) as any;
const engineResult = read("assemblyai-two-person.json");
const recorded = (id: string) => read(`recordings/${id}.json`).response;

const READ = "openid mail:read meetings:read";
const WRITE = "openid mail:read meetings:read meetings:write";

let server: Server;
let stack: StorageStack;

async function body(req: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await body(req);
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v2/upload") return json({ upload_url: "https://cdn.example.test/audio/1" });
    if (req.url === "/v2/transcript" && req.method === "POST") {
      return json({ id: "job-1", status: "queued" });
    }
    if (req.url === "/v2/transcript/job-1" && req.method === "GET") return json(engineResult);
    if (req.url === "/v2/transcript/job-1" && req.method === "DELETE") return json({});
    if (req.url?.startsWith("/v1/messages")) {
      const system = String(JSON.parse(raw.toString()).system);
      return json(
        recorded(system.includes("who is speaking") ? "naming-call-no-mic" : "notes-two-person-es"),
      );
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      TRANSCRIBE_PROVIDER: "assemblyai",
      TRANSCRIBE_URL: origin,
      ANTHROPIC_BASE_URL: origin,
    },
    secrets: { ANTHROPIC_API_KEY: "recorded", TRANSCRIBE_API_KEY: "recorded" },
  });
}, 120_000);
afterAll(async () => {
  await stack?.stop();
  server?.close();
});

async function api(person: Person, method: string, path: string, payload?: unknown) {
  const response = await fetch(new URL(`/api/meetings${path}`, stack.worker.url), {
    method,
    headers: {
      cookie: person.jar.header,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const answer = await agent.callTool({ name, arguments: args });
  if (answer.isError) throw new Error(JSON.stringify(answer.content));
  return answer.structuredContent as any;
}

async function refusal(agent: Client, name: string, args: Record<string, unknown>) {
  const answer = await agent.callTool({ name, arguments: args });
  expect(answer.isError).toBe(true);
  return (answer.content as { text: string }[])[0]!.text;
}

async function recordedCall() {
  const org = await stack.company(`meetmcp-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const cy = await stack.member(org.id);
  const started = await api(dana, "POST", "", {
    title: "Entregas sitio web",
    attendees: [
      { address: dana.email, name: "Dana Ruiz" },
      { address: "marta@client.test", name: "Marta Gil" },
      { address: ben.email, name: "Ben" },
    ],
    consent: true,
  });
  expect(started.status).toBe(201);
  const { meetingId, folderId } = started.body;
  const audio = new Uint8Array(4096).map((_, i) => i % 251);
  const node = await stack.upload(dana.jar, { parentId: folderId }, "call.ogg", audio, "audio/ogg");
  const micSpans = engineResult.utterances
    .filter((u: any) => u.speaker === "A")
    .map((u: any) => ({ startMs: u.start, endMs: u.end }));
  const stopped = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: node.id,
    durationMs: 95_400,
    micSpans,
  });
  expect(stopped.status).toBe(204);
  const deadline = Date.now() + 50_000;
  for (;;) {
    const status = (await api(dana, "GET", `/${meetingId}`)).body?.meeting?.status;
    if (status === "ready") break;
    if (status === "failed" || Date.now() > deadline) throw new Error(`meeting ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { org, dana, ben, cy, meetingId: meetingId as string };
}

test("an agent finds a meeting by words, people, dates and client, and reads it with names, only where its person can open it", async () => {
  const { org, dana, cy, meetingId } = await recordedCall();
  const agent = await connectAgent(stack.worker.url, dana.jar, { scope: READ });
  const url = `${WEB_ORIGIN}/${org.slug}/meetings/${meetingId}`;

  const said = await call(agent, "meetings_search", { query: "deploy" });
  expect(said.results).toHaveLength(1);
  expect(said.results[0]).toMatchObject({
    id: meetingId,
    url,
    title: "Entregas sitio web",
    group: { key: "domain:client.test", kind: "client" },
    match: { at: "00:07", speaker: "Marta Gil", text: expect.stringContaining("deploy") },
  });
  const inNotes = await call(agent, "meetings_search", { query: "despliegue" });
  expect(inNotes.results.map((r: any) => [r.id, r.match])).toEqual([[meetingId, null]]);
  expect((await call(agent, "meetings_search", { query: "zanahoria" })).results).toEqual([]);

  for (const people of [["marta@client.test"], ["Marta"], ["marta", "dana ruiz"]]) {
    const found = await call(agent, "meetings_search", { people });
    expect([people, found.results.map((r: any) => r.id)]).toEqual([people, [meetingId]]);
  }
  expect((await call(agent, "meetings_search", { people: ["nobody@else.test"] })).results).toEqual(
    [],
  );
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  expect((await call(agent, "meetings_search", { after: tomorrow })).results).toEqual([]);
  expect(
    (await call(agent, "meetings_search", { after: yesterday, before: tomorrow })).results,
  ).toHaveLength(1);
  expect((await call(agent, "meetings_search", { group: "client.test" })).results).toHaveLength(1);
  expect((await call(agent, "meetings_search", { group: "series:other" })).results).toEqual([]);

  const fetched = await call(agent, "meetings_fetch", { ids: [meetingId, "missing-id"] });
  expect(fetched.not_found).toEqual(["missing-id"]);
  const [meeting] = fetched.meetings;
  expect(meeting).toMatchObject({ id: meetingId, url, role: "owner", status: "ready" });
  expect(meeting.speakers).toEqual([
    { label: "A", name: expect.any(String), address: dana.email, named: true },
    { label: "B", name: "Marta Gil", address: "marta@client.test", named: true },
  ]);
  expect(meeting.transcript).toContain("[00:07] Marta Gil: Claro. El diseño final");
  expect(meeting.transcript.trim().split("\n")).toHaveLength(6);
  expect(meeting.notes.summary).toMatch(/acceso/i);
  expect(meeting.notes.highlights[0]).toMatchObject({ at: expect.stringMatching(/^\d\d:\d\d$/) });
  expect(meeting.actions.map((a: any) => a.kind).toSorted()).toEqual(["email", "task", "task"]);
  const short = await call(agent, "meetings_fetch", { ids: [meetingId], transcript: false });
  expect(short.meetings[0].transcript).toBeUndefined();

  const groups = await call(agent, "meetings_group", {});
  expect(groups.groups).toEqual([
    expect.objectContaining({
      key: "domain:client.test",
      title: "client.test",
      meeting_count: 1,
      url: `${WEB_ORIGIN}/${org.slug}/meetings/g/domain%3Aclient.test`,
    }),
  ]);
  const digest = await call(agent, "meetings_group", { group: "client.test" });
  expect(digest.groups[0].meetings.map((m: any) => m.id)).toEqual([meetingId]);
  expect(digest.groups[0].timeline.length).toBe(meeting.notes.highlights.length);

  const outsider = await connectAgent(stack.worker.url, cy.jar, { scope: READ });
  expect((await call(outsider, "meetings_search", { query: "deploy" })).results).toEqual([]);
  expect((await call(outsider, "meetings_search", {})).results).toEqual([]);
  expect((await call(outsider, "meetings_fetch", { ids: [meetingId] })).meetings).toEqual([]);
  expect(await refusal(outsider, "meetings_group", { group: "client.test" })).toMatch(
    /No meetings/,
  );
  expect((await call(outsider, "meetings_group", {})).groups).toEqual([]);
});

test("accepting a meeting's actions makes one task and one unsent draft however often it is asked", async () => {
  const { org, dana, ben, meetingId } = await recordedCall();
  const mailbox = await createMailbox(stack.db, org.id, dana.email, "personal");
  await grant(stack.db, org.id, mailbox.id, dana.id);
  const agent = await connectAgent(stack.worker.url, dana.jar, { scope: WRITE });
  const reader = await connectAgent(stack.worker.url, dana.jar, { scope: READ });
  const [meeting] = (await call(agent, "meetings_fetch", { ids: [meetingId] })).meetings;
  const [task, otherTask] = meeting.actions.filter((a: any) => a.kind === "task");
  const email = meeting.actions.find((a: any) => a.kind === "email");

  const viewer = await connectAgent(stack.worker.url, ben.jar, { scope: WRITE });
  expect(
    await refusal(viewer, "meetings_decide", { action_id: task.id, decision: "accept" }),
  ).toMatch(/editors/);
  await expect(
    reader.callTool({
      name: "meetings_decide",
      arguments: { action_id: task.id, decision: "accept" },
    }),
  ).rejects.toThrow(/meetings:write/);

  const accepted = await call(agent, "meetings_decide", { action_id: task.id, decision: "accept" });
  expect(accepted).toMatchObject({ kind: "task", state: "done", already_decided: false });
  const again = await call(agent, "meetings_decide", { action_id: task.id, decision: "accept" });
  expect(again).toMatchObject({ state: "done", already_decided: true, task_id: accepted.task_id });
  const tasks = await stack.db
    .select()
    .from(schema.calendarTasks)
    .where(eq(schema.calendarTasks.title, task.title));
  expect(tasks.map((t) => [t.id, t.ownerMemberId])).toEqual([[accepted.task_id, dana.id]]);

  const dismissed = await call(agent, "meetings_decide", {
    action_id: otherTask.id,
    decision: "dismiss",
  });
  expect(dismissed).toMatchObject({ state: "dismissed", task_id: null });
  expect(
    await stack.db
      .select()
      .from(schema.calendarTasks)
      .where(eq(schema.calendarTasks.title, otherTask.title)),
  ).toEqual([]);

  const drafted = await call(agent, "meetings_decide", { action_id: email.id, decision: "accept" });
  expect(drafted.draft).toMatchObject({ to: email.to, subject: email.subject });
  expect(new URL(drafted.draft.url).searchParams.get("draft")).toBe(drafted.draft.id);
  const redrafted = await call(agent, "meetings_decide", {
    action_id: email.id,
    decision: "accept",
  });
  expect(redrafted).toMatchObject({ already_decided: true, draft: drafted.draft });
  const drafts = await stack.db
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.mailboxId, mailbox.id));
  expect(drafts.map((d) => [d.id, d.kind, d.subject, d.to.map((t) => t.address)])).toEqual([
    [drafted.draft.id, "new", email.subject, email.to],
  ]);
  expect(
    await stack.db
      .select()
      .from(schema.mailActions)
      .where(
        and(eq(schema.mailActions.mailboxId, mailbox.id), eq(schema.mailActions.kind, "send")),
      ),
  ).toEqual([]);

  const after = (await call(agent, "meetings_fetch", { ids: [meetingId] })).meetings[0];
  expect(Object.fromEntries(after.actions.map((a: any) => [a.id, a.state]))).toEqual({
    [task.id]: "done",
    [otherTask.id]: "dismissed",
    [email.id]: "done",
  });
});

test("renaming a speaker and sharing a meeting are for its editors, and sharing again changes nothing", async () => {
  const { dana, ben, cy, meetingId } = await recordedCall();
  const agent = await connectAgent(stack.worker.url, dana.jar, { scope: WRITE });
  const viewer = await connectAgent(stack.worker.url, ben.jar, { scope: WRITE });
  const outsider = await connectAgent(stack.worker.url, cy.jar, { scope: WRITE });

  const rename = { meeting_id: meetingId, speaker: "B", name: "Marta Gil López" };
  expect(await refusal(viewer, "meetings_rename_speaker", rename)).toMatch(/editors/);
  expect(await refusal(outsider, "meetings_rename_speaker", rename)).toMatch(/No meeting/);
  expect(await refusal(agent, "meetings_rename_speaker", { ...rename, speaker: "Z" })).toMatch(
    /no speaker/,
  );
  for (let i = 0; i < 2; i++) await call(agent, "meetings_rename_speaker", rename);
  const fetched = (await call(viewer, "meetings_fetch", { ids: [meetingId] })).meetings[0];
  expect(fetched.speakers.find((s: any) => s.label === "B")).toMatchObject({
    name: "Marta Gil López",
  });
  expect(fetched.transcript).toContain("Marta Gil López: Claro.");

  const share = { meeting_id: meetingId, people: [{ address: cy.email, role: "viewer" }] };
  expect(await refusal(viewer, "meetings_share", share)).toMatch(/editors/);
  expect(await refusal(outsider, "meetings_share", share)).toMatch(/No meeting/);
  const shared = await call(agent, "meetings_share", share);
  const again = await call(agent, "meetings_share", share);
  expect(again.people).toEqual(shared.people);
  expect(shared.people).toContainEqual({ address: cy.email, role: "viewer" });
  expect(shared.people).toContainEqual({ address: dana.email, role: "owner" });
  expect(
    await refusal(agent, "meetings_share", {
      meeting_id: meetingId,
      people: [{ address: dana.email, role: "viewer" }],
    }),
  ).toMatch(/owns/);
  const [opened] = (await call(outsider, "meetings_fetch", { ids: [meetingId] })).meetings;
  expect(opened).toMatchObject({ id: meetingId, role: "viewer" });

  const promoted = await call(agent, "meetings_share", {
    meeting_id: meetingId,
    people: [{ address: cy.email, role: "editor" }],
    access: "workspace",
  });
  expect(promoted).toMatchObject({ access: "workspace" });
  expect(promoted.people).toContainEqual({ address: cy.email, role: "editor" });
  await call(outsider, "meetings_rename_speaker", { ...rename, name: "Marta" });
});

test("a group's digest covers every meeting it lists, past the twelve its summary is made from", async () => {
  const org = await stack.company(`meetgrp-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ids: string[] = [];
  for (let i = 0; i < 13; i++) {
    const [meeting] = await stack.db
      .insert(schema.meetingsMeetings)
      .values({
        orgId: org.id,
        title: `Weekly ${i}`,
        startedAt: new Date(Date.UTC(2026, 9, 1 + i)),
        groupKey: "domain:client.test",
        recordedByMemberId: dana.id,
        consentAt: new Date(),
        status: "ready",
      })
      .returning();
    await stack.db.insert(schema.meetingsNotes).values({
      meetingId: meeting!.id,
      orgId: org.id,
      summary: `Summary ${i}`,
      highlights: [{ text: `Highlight ${i}`, atMs: 1000 }],
      topics: [],
      model: "recorded",
      promptVersion: 1,
    });
    ids.unshift(meeting!.id);
  }
  const agent = await connectAgent(stack.worker.url, dana.jar, { scope: READ });
  const [digest] = (await call(agent, "meetings_group", { group: "client.test" })).groups;
  expect(digest.meetings.map((m: any) => m.id)).toEqual(ids);
  expect(digest.meetings.map((m: any) => m.summary)).not.toContain(null);
  expect(digest.timeline).toHaveLength(13);
});

/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers and engine fixtures */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

const fixtures = new URL("../../../fixtures/meetings/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, fixtures), "utf8")) as any;
const engineResult = read("assemblyai-two-person.json");
const recorded = (id: string) => read(`recordings/${id}.json`).response;

const fake = {
  submitted: [] as any[],
  uploadedBytes: 0,
  forgotten: [] as string[],
  modelCalls: [] as string[],
  failJobs: 0,
};
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
    if (req.url === "/v2/upload") {
      fake.uploadedBytes += raw.length;
      return json({ upload_url: "https://cdn.example.test/audio/1" });
    }
    if (req.url === "/v2/transcript" && req.method === "POST") {
      fake.submitted.push(JSON.parse(raw.toString()));
      if (fake.failJobs > 0) {
        fake.failJobs--;
        return json({ id: "job-err", status: "queued" });
      }
      return json({ id: "job-1", status: "queued" });
    }
    if (req.url === "/v2/transcript/job-err" && req.method === "GET") {
      return json({ id: "job-err", status: "error", error: "audio could not be decoded" });
    }
    if (req.url === "/v2/transcript/job-1" && req.method === "GET") return json(engineResult);
    if (req.url === "/v2/transcript/job-1" && req.method === "DELETE") {
      fake.forgotten.push("job-1");
      return json({});
    }
    if (req.url?.startsWith("/v1/messages")) {
      const system = String(JSON.parse(raw.toString()).system);
      const kind = system.includes("who is speaking") ? "naming" : "notes";
      fake.modelCalls.push(kind);
      return json(recorded(kind === "naming" ? "naming-call-no-mic" : "notes-two-person-es"));
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
  const response = await fetch(
    new URL(`/api/meetings${path === "/" ? "" : path}`, stack.worker.url),
    {
      method,
      headers: {
        cookie: person.jar.header,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 50_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test("a recorded call becomes a transcript with names, notes and actions, for its attendees only", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const cy = await stack.member(org.id);
  const marta = "marta@client.test";

  const started = await api(dana, "POST", "/", {
    title: "Entregas sitio web",
    attendees: [
      { address: dana.email, name: "Dana Ruiz" },
      { address: marta, name: "Marta Gil" },
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
  expect(
    (
      await api(ben, "POST", `/${meetingId}/stop`, {
        audioNodeId: node.id,
        durationMs: 95_400,
        micSpans,
      })
    ).status,
  ).toBe(403);
  const stopped = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: node.id,
    durationMs: 95_400,
    micSpans,
  });
  expect(stopped.status).toBe(204);

  const ready = await until(
    () => api(dana, "GET", `/${meetingId}`),
    (r) => ["ready", "failed"].includes(r.body?.meeting?.status),
  );
  expect(ready.body.meeting).toMatchObject({ status: "ready", language: "es", failure: null });

  expect(fake.uploadedBytes).toBe(audio.length);
  expect(fake.submitted[0]).toMatchObject({
    speaker_labels: true,
    speech_understanding: {
      request: { speaker_identification: { known_values: expect.arrayContaining(["Marta Gil"]) } },
    },
  });
  expect(fake.forgotten).toEqual(["job-1"]);
  expect(fake.modelCalls).toEqual(["naming", "notes"]);

  const speakers = Object.fromEntries(ready.body.speakers.map((s: any) => [s.label, s]));
  expect(speakers.A).toMatchObject({ address: dana.email, source: "mic" });
  expect(speakers.B).toMatchObject({ name: "Marta Gil", address: marta, source: "ai" });
  expect(ready.body.notes.summary).toMatch(/acceso/i);
  const email = ready.body.actions.find((a: any) => a.kind === "email");
  expect(email.payload.to).toContain(marta);

  const task = ready.body.actions.find((a: any) => a.kind === "task");
  expect((await api(ben, "POST", `/actions/${task.id}/accept`)).status).toBe(403);
  const accepted = await api(dana, "POST", `/actions/${task.id}/accept`);
  expect(accepted.body.action).toMatchObject({ state: "done" });
  const [made] = await stack.db
    .select()
    .from(schema.calendarTasks)
    .where(eq(schema.calendarTasks.title, task.payload.title));
  expect(made).toMatchObject({ ownerMemberId: dana.id, recordKind: null });
  expect((await api(dana, "POST", `/actions/${task.id}/accept`)).status).toBe(409);
  expect(
    await stack.db
      .select()
      .from(schema.calendarTasks)
      .where(eq(schema.calendarTasks.title, task.payload.title)),
  ).toHaveLength(1);

  const transcript = await api(ben, "GET", `/${meetingId}/transcript`);
  expect(transcript.body.segments).toHaveLength(6);
  expect((await api(ben, "GET", `/${meetingId}`)).body.role).toBe("viewer");
  expect((await api(ben, "PATCH", `/${meetingId}`, { title: "mine" })).status).toBe(403);
  expect((await api(cy, "GET", `/${meetingId}`)).status).toBe(404);
  expect((await api(cy, "GET", `/${meetingId}/audio`)).status).toBe(404);
  expect((await api(cy, "GET", "/search?q=acceso")).body.hits).toEqual([]);
  expect((await api(ben, "GET", "/search?q=acceso")).body.hits.length).toBeGreaterThan(0);

  const ranged = await fetch(new URL(`/api/meetings/${meetingId}/audio`, stack.worker.url), {
    headers: { cookie: ben.jar.header, range: "bytes=0-9" },
  });
  expect(ranged.status).toBe(206);
  expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(audio.subarray(0, 10));

  const [usage] = await stack.db
    .select()
    .from(schema.aiUsage)
    .where(eq(schema.aiUsage.orgId, org.id));
  expect(usage?.tokensIn).toBeGreaterThan(0);

  expect((await api(dana, "POST", `/${meetingId}/retry`)).status).toBe(409);
  const bucket = await stack.bucket();
  expect(await bucket.head(`meetings/${org.id}/${meetingId}/engine.json`)).not.toBeNull();
  expect((await api(ben, "DELETE", `/${meetingId}`)).status).toBe(403);
  expect((await api(dana, "DELETE", `/${meetingId}`)).status).toBe(204);
  expect(await bucket.head(`meetings/${org.id}/${meetingId}/engine.json`)).toBeNull();
  expect((await api(ben, "GET", `/${meetingId}`)).status).toBe(404);
  const [audioNode] = await stack.db
    .select({ trashedAt: schema.storageNodes.trashedAt })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, node.id));
  expect(audioNode?.trashedAt).not.toBeNull();
});

test("a recording that is not the recorder's own file is refused", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const { meetingId } = (await api(dana, "POST", "/", { attendees: [], consent: true })).body;
  const theirs = await stack.upload(
    ben.jar,
    { space: "personal" },
    "x.ogg",
    new Uint8Array(10),
    "audio/ogg",
  );
  const refused = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: theirs.id,
    durationMs: 1000,
    micSpans: null,
  });
  expect(refused.status).toBe(400);
  expect((await api(dana, "POST", "/", { attendees: [] })).status).toBe(400);
});

async function recordCall(dana: Person) {
  const started = await api(dana, "POST", "/", {
    attendees: [{ address: "marta@client.test", name: "Marta Gil" }],
    consent: true,
  });
  const { meetingId, folderId } = started.body;
  const node = await stack.upload(
    dana.jar,
    { parentId: folderId },
    "c.ogg",
    new Uint8Array(64),
    "audio/ogg",
  );
  const stopped = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: node.id,
    durationMs: 95_400,
    micSpans: null,
  });
  expect(stopped.status).toBe(204);
  return meetingId as string;
}

const settled = (dana: Person, meetingId: string) =>
  until(
    () => api(dana, "GET", `/${meetingId}`),
    (r) => ["ready", "failed"].includes(r.body?.meeting?.status),
  );

test("a meeting the engine failed on is sent again on retry, as a new engine job", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  fake.failJobs = 1;
  const before = fake.submitted.length;
  const meetingId = await recordCall(dana);

  const failed = await settled(dana, meetingId);
  expect(failed.body.meeting).toMatchObject({ status: "failed" });
  expect(failed.body.meeting.failure).toContain("audio could not be decoded");

  expect((await api(dana, "POST", `/${meetingId}/retry`)).status).toBe(204);
  const ready = await settled(dana, meetingId);
  expect(ready.body.meeting.status).toBe("ready");
  expect(fake.submitted.length - before).toBe(2);
});

test("a step delivered late carries the meeting on from its saved status", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const meetingId = await recordCall(dana);
  expect((await settled(dana, meetingId)).body.meeting.status).toBe("ready");

  await stack.db
    .update(schema.meetingsMeetings)
    .set({ status: "writing" })
    .where(eq(schema.meetingsMeetings.id, meetingId));
  const env = await stack.worker.server
    .getWorker<{ AI_QUEUE: { send(body: unknown): Promise<unknown> } }>()
    .getEnv();
  await env.AI_QUEUE.send({ kind: "meeting", meetingId, orgId: org.id, step: "poll" });

  const resumed = await settled(dana, meetingId);
  expect(resumed.body.meeting.status).toBe("ready");
});

test("a stopped meeting whose hand-off to the queue was lost is sent on by the minute sweep", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const { meetingId, folderId } = (await api(dana, "POST", "/", { attendees: [], consent: true }))
    .body;
  const node = await stack.upload(
    dana.jar,
    { parentId: folderId },
    "c.ogg",
    new Uint8Array(64),
    "audio/ogg",
  );
  const longAgo = new Date(Date.now() - 10 * 60_000);
  await stack.db
    .update(schema.meetingsMeetings)
    .set({ status: "uploaded", audioNodeId: node.id, durationMs: 95_400, updatedAt: longAgo })
    .where(eq(schema.meetingsMeetings.id, meetingId));
  await stack.db
    .update(schema.meetingsJobs)
    .set({ updatedAt: longAgo })
    .where(eq(schema.meetingsJobs.meetingId, meetingId));

  expect(await stack.cron("* * * * *")).toBe("ok");
  expect((await settled(dana, meetingId)).body.meeting.status).toBe("ready");
  const stopReady = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: node.id,
    durationMs: 95_400,
    micSpans: null,
  });
  expect(stopReady.status).toBe(409);
});

test("stopping again while the meeting waits for the pipeline sends it on instead of refusing", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const { meetingId, folderId } = (await api(dana, "POST", "/", { attendees: [], consent: true }))
    .body;
  const node = await stack.upload(
    dana.jar,
    { parentId: folderId },
    "c.ogg",
    new Uint8Array(64),
    "audio/ogg",
  );
  await stack.db
    .update(schema.meetingsMeetings)
    .set({ status: "uploaded", audioNodeId: node.id, durationMs: 95_400 })
    .where(eq(schema.meetingsMeetings.id, meetingId));
  const again = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: node.id,
    durationMs: 95_400,
    micSpans: null,
  });
  expect(again.status).toBe(204);
  expect((await settled(dana, meetingId)).body.meeting.status).toBe("ready");
});

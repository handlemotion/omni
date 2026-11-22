/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers and engine fixtures */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forUser, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { authPost, WEB_ORIGIN } from "./support.ts";

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
  unavailablePolls: 0,
  holdSubmit: null as Promise<void> | null,
  submitArrived: () => {},
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
      if (fake.holdSubmit) {
        fake.submitArrived();
        await fake.holdSubmit;
      }
      if (fake.failJobs > 0) {
        fake.failJobs--;
        return json({ id: "job-err", status: "queued" });
      }
      return json({ id: "job-1", status: "queued" });
    }
    if (req.url === "/v2/transcript/job-err" && req.method === "GET") {
      return json({ id: "job-err", status: "error", error: "audio could not be decoded" });
    }
    if (req.url === "/v2/transcript/job-1" && req.method === "GET") {
      if (fake.unavailablePolls > 0) {
        fake.unavailablePolls--;
        res.writeHead(503).end("busy");
        return;
      }
      return json(engineResult);
    }
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
      MEETINGS_FIRST_RETRY_SECONDS: "1",
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
  await stack.db
    .update(schema.meetingsActions)
    .set({ payload: { ...task.payload, description: "So Marta can review it before Friday." } })
    .where(eq(schema.meetingsActions.id, task.id));
  expect((await api(ben, "POST", `/actions/${task.id}/accept`)).status).toBe(403);
  const accepted = await api(dana, "POST", `/actions/${task.id}/accept`);
  expect(accepted.body.action).toMatchObject({ state: "done" });
  const [made] = await stack.db
    .select()
    .from(schema.calendarTasks)
    .where(eq(schema.calendarTasks.title, task.payload.title));
  expect(made).toMatchObject({ ownerMemberId: dana.id, recordKind: null });
  expect(made?.body).toContain("So Marta can review it before Friday.");
  expect((await api(dana, "POST", `/actions/${task.id}/accept`)).status).toBe(409);
  expect(
    await stack.db
      .select()
      .from(schema.calendarTasks)
      .where(eq(schema.calendarTasks.title, task.payload.title)),
  ).toHaveLength(1);

  const transcript = await api(ben, "GET", `/${meetingId}/transcript`);
  expect(transcript.body.segments).toHaveLength(6);
  expect(ready.body.notes).toMatchObject({ decisions: [], questions: [], chapters: [] });
  const spoken = new Map<string, number>();
  for (const g of transcript.body.segments) {
    spoken.set(g.speaker, (spoken.get(g.speaker) ?? 0) + g.endMs - g.startMs);
  }
  expect(Object.fromEntries(ready.body.talk.map((t: any) => [t.label, t.ms]))).toEqual(
    Object.fromEntries(spoken),
  );
  expect(ready.body.talk.reduce((sum: number, t: any) => sum + t.share, 0)).toBeCloseTo(1, 2);
  expect(ready.body.talk[0].ms).toBeGreaterThanOrEqual(ready.body.talk.at(-1).ms);
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
  const longAgo = new Date(Date.now() - 20 * 60_000);
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

test("a recording must be an audio file: a document from My files is refused", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const { meetingId, folderId } = (await api(dana, "POST", "/", { attendees: [], consent: true }))
    .body;
  const doc = await stack.upload(
    dana.jar,
    { parentId: folderId },
    "plan.html",
    new TextEncoder().encode("<p>plan</p>"),
    "text/html",
  );
  const refused = await api(dana, "POST", `/${meetingId}/stop`, {
    audioNodeId: doc.id,
    durationMs: 1000,
    micSpans: null,
  });
  expect(refused).toMatchObject({ status: 400, body: { code: "BAD_REQUEST" } });
  expect((await api(dana, "GET", `/${meetingId}`)).body.meeting.hasAudio).toBe(false);
});

test("a range the recording cannot satisfy answers 416 with its size, not a server error", async () => {
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
  const stop = { audioNodeId: node.id, durationMs: 1000, micSpans: null };
  expect((await api(dana, "POST", `/${meetingId}/stop`, stop)).status).toBe(204);
  const get = (range: string) =>
    fetch(new URL(`/api/meetings/${meetingId}/audio`, stack.worker.url), {
      headers: { cookie: dana.jar.header, range },
    });
  for (const range of ["bytes=64-", "bytes=1000-2000", "bytes=50-10", "bytes=-0"]) {
    const answer = await get(range);
    expect([range, answer.status, answer.headers.get("content-range")]).toEqual([
      range,
      416,
      "bytes */64",
    ]);
  }
  const last = await get("bytes=60-1000");
  expect([last.status, last.headers.get("content-range")]).toEqual([206, "bytes 60-63/64"]);
  expect((await last.arrayBuffer()).byteLength).toBe(4);
  await settled(dana, meetingId);
});

test("a meeting deleted while its audio goes to the engine leaves nothing at the engine or in R2", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  let release = () => {};
  fake.holdSubmit = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (fake.submitArrived = resolve));
  const forgottenBefore = fake.forgotten.length;
  try {
    const meetingId = await recordCall(dana);
    await arrived;
    expect((await api(dana, "DELETE", `/${meetingId}`)).status).toBe(204);
    release();
    await until(
      async () => fake.forgotten.length,
      (n) => n > forgottenBefore,
    );
    expect(fake.forgotten.slice(forgottenBefore)).toEqual(["job-1"]);
    const bucket = await stack.bucket();
    expect(await bucket.list({ prefix: `meetings/${org.id}/${meetingId}/` })).toMatchObject({
      objects: [],
    });
  } finally {
    fake.holdSubmit = null;
    release();
  }
});

test("an engine that is briefly down is tried again after a pause, and the meeting finishes", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  fake.unavailablePolls = 1;
  const meetingId = await recordCall(dana);
  const ready = await until(
    () => api(dana, "GET", `/${meetingId}`),
    (r) => ["ready", "failed"].includes(r.body?.meeting?.status),
    55_000,
  );
  expect(ready.body.meeting).toMatchObject({ status: "ready", failure: null });
  expect(fake.unavailablePolls).toBe(0);
  const [job] = await stack.db
    .select({ attempts: schema.meetingsJobs.attempts })
    .from(schema.meetingsJobs)
    .where(eq(schema.meetingsJobs.meetingId, meetingId));
  expect(job?.attempts).toBe(0);
});

test("a recorder who leaves loses the meetings they recorded; whoever is handed their files owns them", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const admin = await stack.member(org.id, "owner");
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const start = (attendees: string[]) =>
    api(dana, "POST", "/", {
      attendees: attendees.map((address) => ({ address })),
      consent: true,
    });
  const attended = (await start([dana.email, ben.email])).body.meetingId as string;
  const recorded = (await start([ben.email])).body.meetingId as string;

  const removed = await authPost(stack.worker, admin.jar, "/organization/remove-member", {
    memberIdOrEmail: dana.email,
  });
  expect(removed.status).toBe(200);

  const gone = forUser(stack.db, dana.userId).meetings;
  expect((await gone.get(recorded)).status).toBe("not_found");
  expect(await gone.get(attended)).toMatchObject({ status: "ok", role: "viewer" });
  expect((await api(ben, "GET", `/${recorded}`)).body.role).toBe("viewer");
  expect((await api(admin, "GET", `/${recorded}`)).body.role).toBe("owner");
  expect((await api(admin, "DELETE", `/${recorded}`)).status).toBe(204);
});

const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function putChunk(
  person: Person,
  meetingId: string,
  seq: number,
  bytes: Uint8Array,
  sha256 = hex(bytes),
) {
  const response = await fetch(
    new URL(`/api/meetings/${meetingId}/chunks/${seq}?endMs=${(seq + 1) * 5000}`, stack.worker.url),
    {
      method: "PUT",
      headers: { cookie: person.jar.header, "x-content-sha256": sha256 },
      body: Buffer.from(bytes),
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

const piece = (seq: number) => new Uint8Array(1000 + seq).map((_, i) => (i * 7 + seq) % 256);

test("a recording sent in chunks, out of order and one twice, is filed whole and transcribed", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const { meetingId, folderId } = (
    await api(dana, "POST", "/", {
      title: "Q4 / plan\u0007 review",
      attendees: [{ address: "marta@client.test", name: "Marta Gil" }],
      consent: true,
    })
  ).body;
  expect((await putChunk(ben, meetingId, 0, piece(0))).status).toBe(404);
  expect((await api(ben, "GET", `/${meetingId}/chunks`)).status).toBe(404);
  for (const seq of [0, 2, 1, 1]) {
    const sent = await putChunk(dana, meetingId, seq, piece(seq));
    expect(sent).toMatchObject({ status: 200, body: { chunk: { seq, sha256: hex(piece(seq)) } } });
  }
  const early = await api(dana, "POST", `/${meetingId}/stop`, {
    chunks: 4,
    durationMs: 20_000,
    micSpans: null,
  });
  expect(early.status).toBe(409);
  expect(early.body.details).toMatchObject({ reason: "missing_chunks", missing: [3] });
  expect((await putChunk(dana, meetingId, 3, piece(3))).status).toBe(200);
  const held = await api(dana, "GET", `/${meetingId}/chunks`);
  expect(held.body.chunks.map((c: any) => c.seq)).toEqual([0, 1, 2, 3]);

  const uploadedBefore = fake.uploadedBytes;
  const stop = { chunks: 4, durationMs: 20_000, micSpans: null };
  expect((await api(dana, "POST", `/${meetingId}/stop`, stop)).status).toBe(204);
  const ready = await settled(dana, meetingId);
  expect(ready.body.meeting).toMatchObject({ status: "ready", failure: null });

  const whole = Buffer.concat([0, 1, 2, 3].map((seq) => Buffer.from(piece(seq))));
  expect(fake.uploadedBytes - uploadedBefore).toBe(whole.length);
  const audio = await fetch(new URL(`/api/meetings/${meetingId}/audio`, stack.worker.url), {
    headers: { cookie: dana.jar.header },
  });
  expect(Buffer.from(await audio.arrayBuffer()).equals(whole)).toBe(true);
  const [file] = await stack.db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.parentId, folderId));
  expect(file).toMatchObject({ kind: "file", size: whole.length, mimeType: "audio/webm" });
  expect(file?.name).toMatch(/^Q4 plan review \d{4}-\d{2}-\d{2}\.webm$/);
  const bucket = await stack.bucket();
  const left = await bucket.list({ prefix: `meetings/${org.id}/${meetingId}/chunks/` });
  expect(left.objects).toEqual([]);

  expect((await putChunk(dana, meetingId, 1, piece(1))).status).toBe(200);
  expect((await putChunk(dana, meetingId, 4, piece(4))).status).toBe(409);
});

test("a chunk is acknowledged only for the bytes it names, and never replaced by other bytes", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const { meetingId } = (await api(dana, "POST", "/", { attendees: [], consent: true })).body;
  const torn = await putChunk(dana, meetingId, 0, piece(0).subarray(0, 500), hex(piece(0)));
  expect(torn.status).toBe(422);
  expect((await api(dana, "GET", `/${meetingId}/chunks`)).body.chunks).toEqual([]);
  expect((await putChunk(dana, meetingId, 0, piece(0))).status).toBe(200);
  expect((await putChunk(dana, meetingId, 0, piece(9))).status).toBe(409);
  const bucket = await stack.bucket();
  const stored = await bucket.list({ prefix: `meetings/${org.id}/${meetingId}/chunks/` });
  expect(stored.objects.map((o: any) => o.key)).toEqual([
    `meetings/${org.id}/${meetingId}/chunks/000000-${hex(piece(0))}`,
  ]);
});

test("a recording whose recorder never came back is stopped by the sweep and transcribed", async () => {
  const org = await stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const { meetingId } = (await api(dana, "POST", "/", { attendees: [], consent: true })).body;
  for (const seq of [0, 1, 2]) await putChunk(dana, meetingId, seq, piece(seq));
  const longAgo = new Date(Date.now() - 13 * 3_600_000);
  await stack.db
    .update(schema.meetingsChunks)
    .set({ receivedAt: longAgo })
    .where(eq(schema.meetingsChunks.meetingId, meetingId));

  expect(await stack.cron("* * * * *")).toBe("ok");
  const ready = await settled(dana, meetingId);
  expect(ready.body.meeting).toMatchObject({ status: "ready", durationMs: 95_400 });
  const [job] = await stack.db
    .select({ chunkCount: schema.meetingsJobs.chunkCount })
    .from(schema.meetingsJobs)
    .where(eq(schema.meetingsJobs.meetingId, meetingId));
  expect(job?.chunkCount).toBe(3);
});

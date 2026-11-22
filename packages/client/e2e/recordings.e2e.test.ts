/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopRecording } from "@omni/contracts";
import { applyGoogleChanges, schema } from "@omni/db";
import { readGoogleEvent, type GoogleCalendarChange } from "@omni/mail-core/calendar";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  startStorageStack,
  type Person,
  type StorageStack,
} from "../../../apps/worker/e2e/storage-support.ts";
import { createMailbox, grant } from "../../../apps/worker/e2e/support.ts";
import { finishRecording, recordingsToFinish, type RecordingSpool } from "../src/index.ts";

const desktop = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url));
const recorder = join(desktop, "target/debug/omni-record");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const engine = { submittedAudioSizes: [] as number[] };
let server: Server;
let stack: StorageStack;

beforeAll(async () => {
  execFileSync("cargo", ["build", "-q", "-p", "omni-recorder", "--bin", "omni-record"], {
    cwd: desktop,
    stdio: "inherit",
  });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (value: unknown) => res.writeHead(200).end(JSON.stringify(value));
      if (req.url === "/v2/upload") {
        return json({ upload_url: `https://cdn.example.test/${body.length}` });
      }
      if (req.url === "/v2/transcript" && req.method === "POST") {
        const url = String(JSON.parse(body.toString()).audio_url);
        engine.submittedAudioSizes.push(Number(url.split("/").pop()));
        return json({ id: `job-${engine.submittedAudioSizes.length}`, status: "queued" });
      }
      if (req.url?.startsWith("/v2/transcript/")) return json({ status: "processing" });
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stack = await startStorageStack({
    vars: {
      RATE_LIMIT_AUTH: "off",
      TRANSCRIBE_PROVIDER: "assemblyai",
      TRANSCRIBE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    secrets: { TRANSCRIBE_API_KEY: "recorded" },
  });
}, 600_000);

afterAll(async () => {
  await stack?.stop();
  server?.close();
});

function spoolThroughOmniRecord(root: string) {
  const run = (...args: string[]) => execFileSync(recorder, args, { maxBuffer: 64 * 1024 * 1024 });
  const spool: RecordingSpool = {
    readPart: async (id, n, size) => new Uint8Array(run("part", root, id, String(n), String(size))),
    mark: async (id, { uploadId, nodeId }) => {
      run(
        "mark",
        root,
        id,
        ...(uploadId ? ["--upload", uploadId] : []),
        ...(nodeId ? ["--node", nodeId] : []),
      );
    },
    discard: async (id) => {
      run("discard", root, id);
    },
  };
  const openApp = () => JSON.parse(run("list", root).toString()) as DesktopRecording[];
  const audio = (id: string) => readFileSync(join(root, id, "audio.ogg"));
  return { spool, open: openApp, audio };
}

function transportCountingCalls(person: Person) {
  const calls: string[] = [];
  const transport = {
    baseUrl: String(stack.worker.url),
    headers: { cookie: person.jar.header },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname.replace(/\/[0-9a-z-]{20,}/g, "/:id")}`);
      return fetch(input, init);
    }) as typeof fetch,
  };
  return { transport, calls };
}

const page = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/google-calendar/events-page.json", import.meta.url),
    "utf8",
  ),
) as { timeZone: string; items: Record<string, unknown>[] };

async function eventOnACalendarBothSee(orgId: string, people: Person[]) {
  const box = await createMailbox(stack.db, orgId, people[0]!.email, "shared", "gmail");
  for (const person of people) await grant(stack.db, orgId, box.id, person.id);
  const [calendar] = await stack.db
    .insert(schema.calendarCalendars)
    .values({ orgId, mailboxId: box.id })
    .returning();
  const changes = page.items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);
  await applyGoogleChanges(stack.db, { id: calendar!.id, orgId }, changes);
  const moved = "2026-11-16T09:00:00.000Z";
  const [event] = await stack.db
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.calendarId, calendar!.id),
        eq(schema.calendarEvents.recurrenceId, new Date(moved)),
      ),
    );
  return { id: event!.id, recurrenceId: "2026-11-16T10:00:00+01:00" };
}

async function startMeeting(person: Person, event: { id: string; recurrenceId: string } | null) {
  const response = await fetch(new URL("/api/meetings", stack.worker.url), {
    method: "POST",
    headers: { cookie: person.jar.header, "content-type": "application/json" },
    body: JSON.stringify({ title: "Week Kickoff", event, attendees: [], consent: true }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function meetingRow(id: string) {
  const [row] = await stack.db
    .select()
    .from(schema.meetingsMeetings)
    .where(eq(schema.meetingsMeetings.id, id));
  return row;
}

async function untilSentToEngine(meetingId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [job] = await stack.db
      .select()
      .from(schema.meetingsJobs)
      .where(eq(schema.meetingsJobs.meetingId, meetingId));
    if (job?.providerJobId || Date.now() > deadline) return job;
    await sleep(250);
  }
}

async function recordingsFiles(person: Person, folderId: string) {
  const listed = await stack.api(person.jar, "GET", `/nodes?parent=${folderId}`);
  return (listed.body?.nodes ?? []) as any[];
}

async function untilKilledAfter(args: string[], ms: number) {
  const child = spawn(recorder, args, { stdio: ["ignore", "pipe", "inherit"] });
  const started = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  await started;
  await sleep(ms);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("an app killed mid-meeting, and again mid-upload, finishes the upload with nothing missing", async () => {
  const org = await stack.company(`rec-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const root = mkdtempSync(join(tmpdir(), "omni-spool-"));
  const { spool, open, audio } = spoolThroughOmniRecord(root);

  const started = await startMeeting(dana, null);
  expect(started.status).toBe(201);
  const { meetingId, folderId } = started.body;

  await untilKilledAfter(
    ["record", root, meetingId, dana.id, folderId, "--synthetic", "--title", "Week Kickoff"],
    4500,
  );
  const [left] = open();
  expect(left).toMatchObject({ meetingId, memberId: dana.id, state: "stopped" });
  expect(left!.uploadId ?? null).toBeNull();
  expect(left!.durationMs).toBeGreaterThan(4000);
  expect(left!.micSpans.slice(0, 2)).toEqual([
    { startMs: 0, endMs: 1500 },
    { startMs: expect.closeTo(2500, -2), endMs: 4000 },
  ]);
  expect(recordingsToFinish(open(), dana.id)).toHaveLength(1);
  expect(recordingsToFinish(open(), "someone-else")).toHaveLength(0);
  const bytes = audio(left!.id);

  const killedMidUpload: RecordingSpool = {
    ...spool,
    readPart: async () => {
      throw new Error("killed");
    },
  };
  const first = transportCountingCalls(dana);
  await expect(finishRecording(first.transport, killedMidUpload, left!)).rejects.toThrow("killed");
  const [resumed] = open();
  expect(resumed!.uploadId).toEqual(expect.any(String));

  const second = transportCountingCalls(dana);
  expect(await finishRecording(second.transport, spool, resumed!)).toBe("finished");
  expect(second.calls).toEqual([
    "GET /api/storage/uploads/:id",
    "PUT /api/storage/uploads/:id/parts/1",
    "POST /api/storage/uploads/:id/complete",
    "POST /api/meetings/:id/stop",
  ]);
  expect(open()).toEqual([]);
  expect(existsSync(join(root, left!.id))).toBe(false);

  const files = await recordingsFiles(dana, folderId);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ name: expect.stringMatching(/^Week Kickoff .*\.ogg$/) });
  const stored = new Uint8Array(await (await stack.download(dana.jar, files[0].id)).arrayBuffer());
  expect(stored.length).toBe(bytes.length);
  expect(sha256(stored)).toBe(sha256(bytes));
  const probed = join(root, "stored.ogg");
  appendFileSync(probed, stored);
  const seconds = Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      probed,
    ]),
  );
  expect(seconds * 1000).toBeCloseTo(left!.durationMs, -2);
  execFileSync("ffmpeg", ["-v", "error", "-i", probed, "-f", "null", "-"]);

  const meeting = await meetingRow(meetingId);
  expect(meeting).toMatchObject({ audioNodeId: files[0].id, durationMs: left!.durationMs });
  expect(meeting!.status).not.toBe("recording");
  const job = await untilSentToEngine(meetingId);
  expect(job).toMatchObject({ micSpans: left!.micSpans, providerJobId: expect.any(String) });
});

test("a large recording resumes at the part it stopped at, and a finish repeated after a crash sends nothing twice", async () => {
  const org = await stack.company(`rec-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const root = mkdtempSync(join(tmpdir(), "omni-spool-"));
  const { spool, open, audio } = spoolThroughOmniRecord(root);

  const event = await eventOnACalendarBothSee(org.id, [dana, ben]);
  const started = await startMeeting(dana, event);
  expect(started.status).toBe(201);
  const { meetingId, folderId } = started.body;
  const twice = await startMeeting(ben, event);
  expect(twice).toMatchObject({ status: 409, body: { status: "recording_elsewhere", meetingId } });

  execFileSync(recorder, [
    "record",
    root,
    meetingId,
    dana.id,
    folderId,
    "--synthetic",
    "--seconds",
    "1",
  ]);
  expect(() =>
    execFileSync(
      recorder,
      ["record", root, meetingId, dana.id, folderId, "--synthetic", "--seconds", "1"],
      {
        stdio: "pipe",
      },
    ),
  ).toThrow(/AlreadySpooled/);
  const [made] = open();
  appendFileSync(
    join(root, made!.id, "audio.ogg"),
    new Uint8Array(33 * 1024 * 1024).map((_, i) => i % 253),
  );
  const [large] = open();
  const bytes = audio(large!.id);

  let sent = 0;
  const killedAfterOnePart: RecordingSpool = {
    ...spool,
    readPart: async (id, n, size) => {
      if (sent++ === 1) throw new Error("killed");
      return spool.readPart(id, n, size);
    },
  };
  await expect(
    finishRecording(transportCountingCalls(dana).transport, killedAfterOnePart, large!),
  ).rejects.toThrow("killed");

  const killedBeforeDiscard: RecordingSpool = {
    ...spool,
    discard: async () => {
      throw new Error("killed");
    },
  };
  const resumed = transportCountingCalls(dana);
  await expect(finishRecording(resumed.transport, killedBeforeDiscard, open()[0]!)).rejects.toThrow(
    "killed",
  );
  expect(resumed.calls.filter((c) => c.startsWith("PUT"))).toEqual([
    "PUT /api/storage/uploads/:id/parts/2",
    "PUT /api/storage/uploads/:id/parts/3",
  ]);

  const last = transportCountingCalls(dana);
  expect(await finishRecording(last.transport, spool, open()[0]!)).toBe("finished");
  expect(last.calls).toEqual(["POST /api/meetings/:id/stop"]);
  expect(open()).toEqual([]);

  const files = await recordingsFiles(dana, folderId);
  expect(files).toHaveLength(1);
  const stored = new Uint8Array(await (await stack.download(dana.jar, files[0].id)).arrayBuffer());
  expect(sha256(stored)).toBe(sha256(bytes));

  expect(await untilSentToEngine(meetingId)).toMatchObject({ providerJobId: expect.any(String) });
  await sleep(2000);
  expect(engine.submittedAudioSizes.filter((size) => size === bytes.length)).toHaveLength(1);
});

test("a recording whose meeting was deleted while it waited keeps its file and leaves the spool", async () => {
  const org = await stack.company(`rec-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const root = mkdtempSync(join(tmpdir(), "omni-spool-"));
  const { spool, open } = spoolThroughOmniRecord(root);
  const { meetingId, folderId } = (await startMeeting(dana, null)).body;
  execFileSync(recorder, [
    "record",
    root,
    meetingId,
    dana.id,
    folderId,
    "--synthetic",
    "--seconds",
    "1",
  ]);
  const deleted = await fetch(new URL(`/api/meetings/${meetingId}`, stack.worker.url), {
    method: "DELETE",
    headers: { cookie: dana.jar.header },
  });
  expect(deleted.status).toBe(204);

  expect(await finishRecording(transportCountingCalls(dana).transport, spool, open()[0]!)).toBe(
    "meeting_gone",
  );
  expect(open()).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
  expect(await recordingsFiles(dana, folderId)).toHaveLength(1);
});

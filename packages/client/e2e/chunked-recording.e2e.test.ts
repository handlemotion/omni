/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  startStorageStack,
  type Person,
  type StorageStack,
} from "../../../apps/worker/e2e/storage-support.ts";
import {
  drainRecording,
  serverChunks,
  type ChunkSpool,
  type RecordingTransport,
  type SpooledChunk,
  type SpooledStop,
} from "../src/index.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const engine = { audioBytes: [] as number[] };
let server: Server;
let stack: StorageStack;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const json = (value: unknown) => res.writeHead(200).end(JSON.stringify(value));
      if (req.url === "/v2/upload") {
        engine.audioBytes.push(Buffer.concat(chunks).length);
        return json({ upload_url: "https://cdn.example.test/a" });
      }
      if (req.url === "/v2/transcript" && req.method === "POST") return json({ id: "job-1" });
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
});

afterAll(async () => {
  await stack?.stop();
  server?.close();
});

function memorySpool() {
  const chunks = new Map<string, Map<number, SpooledChunk & { acked: boolean }>>();
  const stops = new Map<string, SpooledStop>();
  const of = (id: string) => chunks.get(id) ?? chunks.set(id, new Map()).get(id)!;
  const spool: ChunkSpool = {
    unsent: async (id) =>
      [...of(id).values()].filter((c) => !c.acked).sort((a, b) => a.seq - b.seq),
    acknowledged: async (id, seq) => void (of(id).get(seq)!.acked = true),
    resend: async (id, seqs) => {
      for (const seq of seqs) of(id).get(seq)!.acked = false;
    },
    stopped: async (id) => stops.get(id) ?? null,
    discard: async (id) => {
      chunks.delete(id);
      stops.delete(id);
    },
  };
  const record = (id: string, seq: number) => {
    const bytes = new Uint8Array(2000 + seq).map((_, i) => (i * 13 + seq) % 256);
    of(id).set(seq, { seq, bytes, sha256: sha256(bytes), endMs: (seq + 1) * 5000, acked: false });
    return bytes;
  };
  const stop = (id: string, stopped: SpooledStop) => void stops.set(id, stopped);
  return { spool, record, stop, held: (id: string) => chunks.get(id)?.size ?? 0 };
}

const transportOf = (person: Person, fetchThrough?: typeof fetch) =>
  ({
    baseUrl: String(stack.worker.url),
    headers: { cookie: person.jar.header },
    fetch: fetchThrough,
  }) satisfies RecordingTransport;

async function startMeeting(person: Person) {
  const response = await fetch(new URL("/api/meetings", stack.worker.url), {
    method: "POST",
    headers: { cookie: person.jar.header, "content-type": "application/json" },
    body: JSON.stringify({ attendees: [], consent: true }),
  });
  return ((await response.json()) as any).meetingId as string;
}

const meetingRow = async (id: string) =>
  (
    await stack.db.select().from(schema.meetingsMeetings).where(eq(schema.meetingsMeetings.id, id))
  )[0];

test("a recording outlives a dropped network and a crash, and stops with every byte", async () => {
  const org = await stack.company(`rec-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const meetingId = await startMeeting(dana);
  const { spool, record, stop, held } = memorySpool();
  const recorded = [0, 1, 2].map((seq) => record(meetingId, seq));

  let offline = true;
  let tries = 0;
  const flaky: typeof fetch = async (input, init) => {
    tries++;
    if (offline) throw new TypeError("Failed to fetch");
    return fetch(input, init);
  };
  const states: number[] = [];
  let crash = false;
  let acks = 0;
  let threeAcked = () => {};
  const acknowledged = spool.acknowledged;
  spool.acknowledged = async (id, seq) => {
    await acknowledged(id, seq);
    if (++acks === 3) threeAcked();
  };
  const sentThree = new Promise<void>((resolve) => (threeAcked = resolve));
  const firstTab = drainRecording(transportOf(dana, flaky), spool, meetingId, {
    wait: async () => {
      if (tries >= 3) offline = false;
      if (crash) throw new Error("the tab closed");
      await new Promise((resolve) => setImmediate(resolve));
    },
    onState: (state) => states.push(state.waiting),
  });
  await sentThree;
  expect((await serverChunks(transportOf(dana), meetingId))!.chunks).toHaveLength(3);
  expect(tries).toBeGreaterThan(3);
  recorded.push(record(meetingId, 3), record(meetingId, 4));
  crash = true;
  await expect(firstTab).rejects.toThrow("the tab closed");

  stop(meetingId, { chunks: 5, durationMs: 25_000, micSpans: null });
  const reloaded = await drainRecording(transportOf(dana), spool, meetingId, {
    wait: async () => {},
  });
  expect(reloaded).toBe("finished");
  expect(held(meetingId)).toBe(0);
  expect(states.some((waiting) => waiting > 0)).toBe(true);

  const whole = Buffer.concat(recorded.map((b) => Buffer.from(b)));
  await expect
    .poll(async () => (await meetingRow(meetingId))?.audioNodeId ?? null, { timeout: 30_000 })
    .not.toBeNull();
  const audio = await fetch(new URL(`/api/meetings/${meetingId}/audio`, stack.worker.url), {
    headers: { cookie: dana.jar.header },
  });
  expect(Buffer.from(await audio.arrayBuffer()).equals(whole)).toBe(true);
  expect(engine.audioBytes).toContain(whole.length);
});

test("a chunk the computer thought was sent but the server never got is sent again before the stop", async () => {
  const org = await stack.company(`rec-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const meetingId = await startMeeting(dana);
  const { spool, record, stop } = memorySpool();
  for (const seq of [0, 1, 2]) record(meetingId, seq);
  await spool.acknowledged(meetingId, 1);
  stop(meetingId, { chunks: 3, durationMs: 15_000, micSpans: null });

  expect(await drainRecording(transportOf(dana), spool, meetingId, { wait: async () => {} })).toBe(
    "finished",
  );
  const held = await serverChunks(transportOf(dana), meetingId);
  expect(held!.chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  expect((await meetingRow(meetingId))?.status).not.toBe("recording");
});

test("a recording whose meeting was deleted is let go instead of tried forever", async () => {
  const org = await stack.company(`rec-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const meetingId = await startMeeting(dana);
  const { spool, record, held } = memorySpool();
  record(meetingId, 0);
  await fetch(new URL(`/api/meetings/${meetingId}`, stack.worker.url), {
    method: "DELETE",
    headers: { cookie: dana.jar.header },
  });
  expect(await drainRecording(transportOf(dana), spool, meetingId, { wait: async () => {} })).toBe(
    "meeting_gone",
  );
  expect(held(meetingId)).toBe(0);
});

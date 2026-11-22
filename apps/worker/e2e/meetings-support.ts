/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers and engine fixtures */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

const fixtures = new URL("../../../fixtures/meetings/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, fixtures), "utf8")) as any;
const engineResult = read("assemblyai-two-person.json");
const recorded = (id: string) => read(`recordings/${id}.json`).response;

const KINDS = [
  ["who is speaking", "naming", "naming-call-no-mic"],
  ["where things stand across a group", "group", "group-kickoffs-en"],
  ["You answer one question", "ask", "ask-call-es"],
  ["notes of a meeting", "notes", "notes-two-person-es"],
] as const;

export type ModelKind = (typeof KINDS)[number][1];

async function body(req: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The local stack with Meetings on: a stand-in AssemblyAI that answers every job with the
 * two-person call, and a stand-in model that replays the recorded answers and keeps every prompt.
 */
export async function startMeetingsStack() {
  const calls: Array<{ kind: ModelKind; user: string }> = [];
  const server: Server = createServer(async (req, res) => {
    const raw = await body(req);
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v2/upload") return json({ upload_url: "https://cdn.example.test/a" });
    if (req.url === "/v2/transcript" && req.method === "POST") {
      return json({ id: "job-1", status: "queued" });
    }
    if (req.url === "/v2/transcript/job-1") return json(req.method === "GET" ? engineResult : {});
    if (req.url?.startsWith("/v1/messages")) {
      const sent = JSON.parse(raw.toString());
      const system = String(sent.system);
      const [, kind, fixture] = KINDS.find(([marker]) => system.includes(marker)) ?? KINDS[3];
      calls.push({ kind, user: String(sent.messages[0]?.content ?? "") });
      return json(recorded(fixture));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stack: StorageStack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      TRANSCRIBE_PROVIDER: "assemblyai",
      TRANSCRIBE_URL: origin,
      ANTHROPIC_BASE_URL: origin,
      MEETINGS_FIRST_RETRY_SECONDS: "",
    },
    secrets: { ANTHROPIC_API_KEY: "recorded", TRANSCRIBE_API_KEY: "recorded" },
  });

  async function api(person: Person | null, method: string, path: string, payload?: unknown) {
    const response = await fetch(new URL(`/api/meetings${path}`, stack.worker.url), {
      method,
      headers: {
        ...(person ? { cookie: person.jar.header } : {}),
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
  }

  async function until<T>(get: () => Promise<T>, done: (value: T) => boolean, ms = 50_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await get();
      if (done(value) || Date.now() > deadline) return value;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function record(
    recorder: Person,
    input: { title: string; attendees: Array<{ address: string; name?: string }> },
    beforeStop?: (meetingId: string) => Promise<void>,
  ) {
    const started = await api(recorder, "POST", "", { ...input, consent: true });
    expect(started.status).toBe(201);
    const { meetingId, folderId } = started.body;
    const node = await stack.upload(
      recorder.jar,
      { parentId: folderId },
      `${meetingId}.ogg`,
      new Uint8Array(64),
      "audio/ogg",
    );
    await beforeStop?.(meetingId);
    const stopped = await api(recorder, "POST", `/${meetingId}/stop`, {
      audioNodeId: node.id,
      durationMs: 95_400,
      micSpans: null,
    });
    expect(stopped.status).toBe(204);
    const ready = await until(
      () => api(recorder, "GET", `/${meetingId}`),
      (r) => ["ready", "failed"].includes(r.body?.meeting?.status),
    );
    expect(ready.body.meeting.status).toBe("ready");
    return { meetingId: meetingId as string, audioNodeId: node.id as string, folderId };
  }

  return {
    stack,
    calls,
    api,
    until,
    record,
    stop: async () => {
      await stack.stop();
      server.close();
    },
  };
}

export type MeetingsStack = Awaited<ReturnType<typeof startMeetingsStack>>;

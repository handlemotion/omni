import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Client } from "@modelcontextprotocol/client";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

const fixtures = new URL("../../../fixtures/drive/", import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, fixtures)));
const recorded = (id: string) =>
  (
    JSON.parse(readFileSync(new URL(`recordings/${id}.json`, fixtures), "utf8")) as {
      response: unknown;
    }
  ).response;

interface ModelRequest {
  messages: { content: { type: string; source?: { media_type: string } }[] }[];
}

const model = { requests: [] as ModelRequest[], failNext: 0 };
let server: Server;
let stack: StorageStack;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
    model.requests.push(body);
    if (model.failNext > 0) {
      model.failNext--;
      res.writeHead(529, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
      return;
    }
    const kind = body.messages[0]!.content[0]!.type;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(recorded(kind === "document" ? "minutes-scan" : "receipt")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_SEARCH: "off",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    secrets: { ANTHROPIC_API_KEY: "recorded" },
  });
}, 120_000);
afterAll(async () => {
  await stack?.stop();
  server?.close();
});

async function indexAll() {
  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");
}

async function search(agent: Client, query: string) {
  const result = await agent.callTool({ name: "drive_search", arguments: { query } });
  return (result.structuredContent as { results: { id: string; title: string }[] }).results;
}

async function textRow(nodeId: string) {
  const [row] = await stack.db
    .select()
    .from(schema.storageTexts)
    .where(eq(schema.storageTexts.nodeId, nodeId));
  return row;
}

test("an agent finds a photo and a scanned PDF by the words in them", async () => {
  const org = await stack.company("ocr");
  const ana = await stack.member(org.id);
  const receipt = await stack.upload(
    ana.jar,
    { space: "personal" },
    "IMG_2041.jpg",
    fixture("receipt.jpg"),
    "image/jpeg",
  );
  const minutes = await stack.upload(
    ana.jar,
    { space: "shared" },
    "scan-0001.pdf",
    fixture("minutes-scan.pdf"),
    "application/pdf",
  );
  await indexAll();

  const sent = model.requests.map((r) => r.messages[0]!.content[0]!);
  expect(sent.map((block) => block.type).toSorted()).toEqual(["document", "image"]);
  expect(sent.find((block) => block.type === "image")?.source?.media_type).toBe("image/jpeg");

  const agent = await connectAgent(stack.worker.url, ana.jar, {
    scope: "openid mail:read drive:read",
    workspace: org.id,
  });
  expect((await search(agent, "farolito")).map((hit) => hit.id)).toEqual([receipt.id]);
  expect((await search(agent, "impermeabilización")).map((hit) => hit.id)).toEqual([minutes.id]);
  const read = await agent.callTool({ name: "drive_fetch", arguments: { id: minutes.id } });
  expect((read.structuredContent as { text: string }).text).toMatch(
    /--- Page 2 ---\nAcuerdos y responsables/,
  );

  const calls = model.requests.length;
  await indexAll();
  expect(model.requests.length).toBe(calls);
});

test("a photo read before OCR was set up is read again, and a model outage is tried again later", async () => {
  const org = await stack.company("backfill");
  const ana = await stack.member(org.id);
  const photo = await stack.upload(
    ana.jar,
    { space: "personal" },
    "whiteboard.jpg",
    fixture("receipt.jpg"),
    "image/jpeg",
  );
  await stack.db.insert(schema.storageTexts).values({
    nodeId: photo.id,
    orgId: org.id,
    contentVersion: photo.contentVersion ?? 1,
    status: "unsupported",
  });

  model.failNext = 1;
  await indexAll();
  expect(await textRow(photo.id)).toMatchObject({ status: "failed", attempts: 1, ocr: true });

  await stack.db
    .update(schema.storageTexts)
    .set({ readAt: new Date(Date.now() - 3_600_000) })
    .where(eq(schema.storageTexts.nodeId, photo.id));
  await indexAll();
  const row = await textRow(photo.id);
  expect(row).toMatchObject({ status: "ok", ocr: true });
  expect(row?.text).toContain("TAQUERÍA EL FAROLITO");

  const untyped = await stack.upload(
    ana.jar,
    { space: "personal" },
    "Ticket.JPG",
    fixture("receipt.jpg"),
  );
  expect(untyped.mimeType).toBeNull();
  await stack.db.insert(schema.storageTexts).values({
    nodeId: untyped.id,
    orgId: org.id,
    contentVersion: untyped.contentVersion ?? 1,
    status: "unsupported",
  });
  await indexAll();
  expect(await textRow(untyped.id)).toMatchObject({ status: "ok", ocr: true });
});

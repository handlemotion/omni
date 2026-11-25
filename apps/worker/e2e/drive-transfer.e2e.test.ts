import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off", RATE_LIMIT_SEARCH: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const WRITE = "openid mail:read drive:read drive:write";
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

// oxlint-disable-next-line typescript/no-explicit-any -- test reads of tool answers
type Answer = any;

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  const answer: Answer = result.isError
    ? { error: (result.content as { text: string }[])[0]!.text }
    : { ...(result.structuredContent as object), content: result.content };
  return answer;
}

const local = (link: string) => {
  const url = new URL(link);
  return new URL(url.pathname + url.search, stack.worker.url).toString();
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function setUp(name: string) {
  const acme = await stack.company(name);
  const ana = await stack.member(acme.id);
  const carl = await stack.member(acme.id);
  const space = await stack.api(ana.jar, "POST", "/teamspaces", { name: "Ana", private: true });
  const teamspaceId = (space.body.teamspace as { id: string }).id;
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const carlAgent = await connectAgent(stack.worker.url, carl.jar, { scope: WRITE });
  return { ana, carl, teamspaceId, agent, carlAgent };
}

test("an agent sends a file from its machine through a signed link, and only the bytes it named", async () => {
  const { ana, teamspaceId, agent } = await setUp("acme-up");
  const bytes = new TextEncoder().encode("a,b\n1,2\n".repeat(1000));

  const opened = await call(agent, "drive_upload", {
    name: "data.csv",
    teamspace_id: teamspaceId,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  });
  expect(opened.upload.command).toMatch(/^curl .* -T 'data.csv' 'http/);
  const wrong = await fetch(local(opened.upload.url), { method: "PUT", body: bytes.slice(1) });
  expect(wrong.status).toBe(400);
  const put = await fetch(local(opened.upload.url), { method: "PUT", body: bytes });
  expect(put.status).toBe(200);
  const node = (await put.json()).node;
  expect(node).toMatchObject({ name: "data.csv", size: bytes.byteLength, mimeType: "text/csv" });
  expect(new Uint8Array(await (await stack.download(ana.jar, node.id)).arrayBuffer())).toEqual(
    bytes,
  );
  expect((await fetch(local(opened.upload.url), { method: "GET" })).status).toBe(404);

  const tampered = await call(agent, "drive_upload", {
    name: "bad.bin",
    teamspace_id: teamspaceId,
    size: 4,
    sha256: sha256(new Uint8Array([1, 2, 3, 4])),
  });
  const refused = await fetch(local(tampered.upload.url), {
    method: "PUT",
    body: new Uint8Array([9, 9, 9, 9]),
  });
  expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({ code: "CHECKSUM_MISMATCH" });
  const listed = await stack.api(ana.jar, "GET", `/nodes?teamspace=${teamspaceId}`);
  expect(listed.body.nodes.map((n: Answer) => n.name)).toEqual(["data.csv"]);

  const parted = await call(agent, "drive_upload", { id: node.id, size: 3 });
  const part = await fetch(local(`${parted.upload.url}?part=1`), { method: "PUT", body: "x,y" });
  expect(part.status).toBe(200);
  const done = await fetch(local(parted.upload.url), { method: "POST" });
  expect((await done.json()).node).toMatchObject({ id: node.id, size: 3 });
  expect(await (await stack.download(ana.jar, node.id)).text()).toBe("x,y");
  const versions = await stack.api(ana.jar, "GET", `/files/${node.id}/versions`);
  expect(versions.body.versions.length).toBeGreaterThanOrEqual(1);

  const [payload, mac] = parted.upload.url.split("/").pop().split(".");
  const forged = parted.upload.url.replace(`${payload}.${mac}`, `${payload}x.${mac}`);
  expect((await fetch(local(forged), { method: "POST" })).status).toBe(404);
});

test("an agent writes small files at once and refuses to overwrite a page people edit live", async () => {
  const { ana, teamspaceId, agent, carlAgent } = await setUp("acme-inline");
  const text = await call(agent, "drive_upload", {
    name: "notes.txt",
    teamspace_id: teamspaceId,
    text: "first line\n",
  });
  expect(text.file).toMatchObject({
    title: "notes.txt",
    mime_type: "text/plain",
    location: "Shared",
  });
  expect(await (await stack.download(ana.jar, text.file.id)).text()).toBe("first line\n");

  const picture = await call(agent, "drive_upload", {
    name: "dot.png",
    teamspace_id: teamspaceId,
    base64: Buffer.from(PNG).toString("base64"),
  });
  expect(picture.file.mime_type).toBe("image/png");

  const doc = await call(agent, "drive_create_doc", {
    name: "Plan",
    teamspace_id: teamspaceId,
    markdown: "# Plan",
  });
  expect((await call(agent, "drive_upload", { id: doc.doc.id, text: "# Gone" })).error).toContain(
    "drive_edit_doc",
  );
  expect(
    (await call(carlAgent, "drive_upload", { id: text.file.id, text: "mine" })).error,
  ).toBeDefined();
  expect(
    (await call(carlAgent, "drive_upload", { name: "x.txt", teamspace_id: teamspaceId, text: "x" }))
      .error,
  ).toBeDefined();
  expect(await (await stack.download(ana.jar, text.file.id)).text()).toBe("first line\n");
});

test("an agent downloads files through short links, sees pictures inline, and nothing it cannot open", async () => {
  const { teamspaceId, agent, carlAgent } = await setUp("acme-down");
  const notes = await call(agent, "drive_upload", {
    name: "notes.txt",
    teamspace_id: teamspaceId,
    text: "hello",
  });
  const picture = await call(agent, "drive_upload", {
    name: "dot.png",
    teamspace_id: teamspaceId,
    base64: Buffer.from(PNG).toString("base64"),
  });

  const got = await call(agent, "drive_download", {
    id: notes.file.id,
    ids: [picture.file.id, "nope"],
    inline: true,
  });
  expect(got.not_found).toEqual(["nope"]);
  expect(got.files[0]).toMatchObject({ title: "notes.txt", base64: btoa("hello") });
  expect(got.files[0].command).toMatch(/^curl .* -o 'notes.txt' 'http/);
  expect(await (await fetch(local(got.files[0].url))).text()).toBe("hello");
  expect(got.content).toContainEqual({
    type: "image",
    mimeType: "image/png",
    data: Buffer.from(PNG).toString("base64"),
  });
  expect(got.files[1]).not.toHaveProperty("base64");

  expect((await fetch(local(got.files[0].url), { method: "PUT", body: "x" })).status).toBe(404);
  expect((await call(carlAgent, "drive_download", { id: notes.file.id })).error).toBeDefined();
});

test("a file over one part goes up in one PUT, split into parts on the way", async () => {
  const { ana, teamspaceId, agent } = await setUp("acme-big");
  const bytes = new Uint8Array(16 * 1024 * 1024 + 123_457);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251;
  const opened = await call(agent, "drive_upload", {
    name: "big.bin",
    teamspace_id: teamspaceId,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  });
  const put = await fetch(local(opened.upload.url), { method: "PUT", body: bytes });
  expect(put.status).toBe(200);
  const node = (await put.json()).node;
  expect(node.size).toBe(bytes.byteLength);
  const back = new Uint8Array(await (await stack.download(ana.jar, node.id)).arrayBuffer());
  expect(sha256(back)).toBe(sha256(bytes));
});

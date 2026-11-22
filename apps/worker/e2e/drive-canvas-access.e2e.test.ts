import { randomUUID } from "node:crypto";
import { applyCanvasOps, CANVAS_TYPE, sceneToJson, type CanvasOp } from "@omni/canvas";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_ACTIONS: "off", RATE_LIMIT_STORAGE_LINK: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const bytes = (text: string) => new TextEncoder().encode(text);

function board(ops: CanvasOp[]) {
  const made = applyCanvasOps({ elements: [] }, ops);
  if (!made.ok) throw new Error(made.error);
  return sceneToJson(made.scene);
}

const canvas = (person: Person, place: { space: "personal" | "shared" }, json: string) =>
  stack.upload(person.jar, place, "Roof repair", bytes(json), CANVAS_TYPE);

async function textOf(nodeId: string) {
  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");
  const [row] = await stack.db
    .select()
    .from(schema.storageTexts)
    .where(eq(schema.storageTexts.nodeId, nodeId));
  return row;
}

test("a canvas is found by the words on it, never by its JSON, and a broken one is not indexed as JSON", async () => {
  const word = `roofer${randomUUID().slice(0, 6)}`;
  const org = await stack.company(`canvas-text-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const json = board([
    { op: "frame", title: "Q1 plan", ref: "plan" },
    { op: "add", kind: "sticky", text: `Call the ${word}`, parent: "plan", ref: "call" },
    { op: "add", kind: "sticky", text: "Order tiles", place: { near: "call", side: "right" } },
  ]);
  const made = await canvas(ana, { space: "shared" }, json);
  expect(made).toMatchObject({ name: "Roof repair", mimeType: CANVAS_TYPE });

  expect(await textOf(made.id)).toMatchObject({
    status: "ok",
    text: `Q1 plan\nCall the ${word}\nOrder tiles`,
  });
  const agent = await connectAgent(stack.worker.url, ana.jar, {
    scope: "openid mail:read drive:read",
  });
  const search = async (query: string) => {
    const found = await agent.callTool({ name: "drive_search", arguments: { query } });
    return (found.structuredContent as { results: { id: string }[] }).results.map((r) => r.id);
  };
  expect(await search(word)).toEqual([made.id]);
  expect(await search("sticky")).toEqual([]);

  const broken = await stack.upload(
    ana.jar,
    { space: "shared" },
    "Broken board",
    bytes('{"omni":"canvas","v":1,"elements":[{"id":"a","kind":"sticky","text":"no box"}]}'),
    CANVAS_TYPE,
  );
  expect(await textOf(broken.id)).toMatchObject({ status: "failed", text: "" });
});

test("an image put on a canvas belongs to it: it opens for whoever opens the canvas, and for no one else", async () => {
  const org = await stack.company(`canvas-images-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bea = await stack.member(org.id);
  const mine = await canvas(ana, { space: "personal" }, board([]));
  const shared = await canvas(ana, { space: "shared" }, board([]));

  const pasted = await stack.upload(
    ana.jar,
    { parentId: shared.id },
    "pasted.png",
    PNG,
    "image/png",
  );
  expect(pasted.parentId).toBe(shared.id);
  const seen = await stack.download(bea.jar, pasted.id);
  expect(Buffer.from(await seen.arrayBuffer())).toEqual(Buffer.from(PNG));

  const hidden = await stack.upload(
    ana.jar,
    { parentId: mine.id },
    "private.png",
    PNG,
    "image/png",
  );
  expect(hidden.parentId).toBe(mine.id);
  const refused = await stack.download(bea.jar, hidden.id);
  await refused.body?.cancel();
  expect(refused.status).toBe(404);
  const listed = await stack.api(ana.jar, "GET", "/nodes?space=shared");
  expect(listed.body.nodes.map((node: { name: string }) => node.name)).toEqual(["Roof repair"]);
});

test("a view-only link opens a canvas and its images as a page, and still refuses downloads", async () => {
  const org = await stack.company(`canvas-link-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const json = board([{ op: "add", kind: "sticky", text: "Visit Tuesday" }]);
  const made = await canvas(ana, { space: "personal" }, json);
  const image = await stack.upload(ana.jar, { parentId: made.id }, "site.png", PNG, "image/png");
  const set = await stack.api(ana.jar, "PUT", `/nodes/${made.id}/sharing/link`, {
    linkAccess: "anyone",
  });
  const shareId = set.body.sharing.shareId as string;
  await stack.api(ana.jar, "PUT", `/nodes/${made.id}/sharing/link`, { downloads: false });

  const visitor = new CookieJar();
  const page = await stack.get(visitor, `/shared/${shareId}/files/${made.id}/view`);
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(json);
  const picture = await stack.get(visitor, `/shared/${shareId}/files/${image.id}/view`);
  expect(Buffer.from(await picture.arrayBuffer())).toEqual(Buffer.from(PNG));
  const download = await stack.get(visitor, `/shared/${shareId}/files/${made.id}/content`);
  await download.body?.cancel();
  expect(download.status).toBe(403);
});

test("a tile of a file the reader cannot open names nothing, and no one can put such a file on a canvas", async () => {
  const org = await stack.company(`canvas-tiles-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bea = await stack.member(org.id);
  const scope = { scope: "openid mail:read drive:read drive:write" };
  const anas = await connectAgent(stack.worker.url, ana.jar, scope);
  const beas = await connectAgent(stack.worker.url, bea.jar, scope);
  const secret = await stack.upload(
    ana.jar,
    { space: "personal" },
    "Secret salaries.pdf",
    bytes("%PDF-1.4"),
    "application/pdf",
  );
  const made = await anas.callTool({
    name: "drive_create_canvas",
    arguments: {
      name: "Budget",
      space: "shared",
      ops: [{ op: "add", kind: "file", file_id: secret.id, page: 2, ref: "tile" }],
    },
  });
  const { canvas: board, created } = made.structuredContent as {
    canvas: { id: string };
    created: { tile: string };
  };

  const read = async (agent: typeof anas) => {
    const fetched = await agent.callTool({ name: "drive_fetch", arguments: { id: board.id } });
    return (fetched.structuredContent as { text: string }).text;
  };
  expect(await read(anas)).toContain(
    `- file ${created.tile} [0,0 400×500] → "Secret salaries.pdf"`,
  );
  const seen = await read(beas);
  expect(seen).toContain(`- file ${created.tile} [0,0 400×500] → no access page 2`);
  expect(seen).not.toContain("Secret");
  expect((await textOf(board.id))?.text).not.toContain("Secret");

  const placed = await beas.callTool({
    name: "drive_edit_canvas",
    arguments: { id: board.id, ops: [{ op: "add", kind: "file", file_id: secret.id }] },
  });
  expect(placed.isError).toBe(true);
  const moved = await beas.callTool({
    name: "drive_edit_canvas",
    arguments: { id: board.id, ops: [{ op: "move", ids: [created.tile], by: { dx: 100, dy: 0 } }] },
  });
  expect(moved.isError).toBeFalsy();
});

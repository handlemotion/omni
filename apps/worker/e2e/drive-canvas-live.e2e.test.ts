import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import {
  applyCanvasOps,
  CANVAS_MAX_BYTES,
  CANVAS_TYPE,
  liveScene,
  rewriteCanvas,
  sceneFromJson,
  sceneToJson,
  type CanvasElement,
  type CanvasOp,
  type Scene,
} from "@omni/canvas";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

const S2 = { url: "http://127.0.0.1:54380/v1", basin: "omni-docs-dev" };

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_ACTIONS: "off",
      S2_BASIN_URL: S2.url,
      S2_BASIN: S2.basin,
    },
  });
}, 120_000);
afterAll(() => stack?.stop());

const WRITE = "openid mail:read drive:read drive:write";
const base64 = (update: Uint8Array) => Buffer.from(update).toString("base64");
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

type Event = Record<string, unknown>;

async function socket(jar: CookieJar, nodeId: string) {
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  const ws = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Event[] = [];
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)) as Event);
    for (const waiter of waiters) waiter();
  });
  const waitFor = (match: (event: Event) => boolean) => {
    const found = Promise.withResolvers<Event>();
    const check = () => {
      const event = received.find(match);
      if (event) found.resolve(event);
    };
    waiters.add(check);
    check();
    return found.promise.finally(() => waiters.delete(check));
  };
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  ws.send(JSON.stringify({ type: "file.presence", nodeId, state: "editing" }));
  let ref = 0;
  const append = async (record: Event, matchSeqNum?: number) => {
    for (;;) {
      const sent = ++ref;
      ws.send(JSON.stringify({ type: "doc.append", nodeId, ref: sent, record, matchSeqNum }));
      const answer = await waitFor(
        (e) => (e.type === "doc.appended" || e.type === "doc.refused") && e.ref === sent,
      );
      if (answer.type === "doc.appended") return answer.seqNum as number;
      if (answer.reason !== "editing") throw new Error(`refused: ${String(answer.reason)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { ws, received, append, waitFor };
}

async function tab(jar: CookieJar, nodeId: string) {
  const live = await socket(jar, nodeId);
  const doc = new Y.Doc();
  let epoch = -1;
  return {
    ...live,
    doc,
    async seed(scene: Scene, contentVersion: number) {
      epoch = await live.append(
        { t: "seed", cv: contentVersion, u: base64(rewriteCanvas(doc, scene)) },
        0,
      );
      return epoch;
    },
    async join(seedAt: number) {
      epoch = seedAt;
      const read = await stack.api(jar, "GET", `/files/${nodeId}/live?from=latest`);
      for (const { record } of read.body.entries as { record: Event }[]) {
        if (record.t !== "fold") Y.applyUpdate(doc, fromBase64(record.u as string));
      }
    },
    change(ops: CanvasOp[]) {
      const changed = applyCanvasOps(liveScene(doc), ops);
      if (!changed.ok) throw new Error(changed.error);
      const update = rewriteCanvas(doc, changed.scene);
      return { send: () => live.append({ t: "update", e: epoch, u: base64(update) }) };
    },
    async hear() {
      const read = await stack.api(jar, "GET", `/files/${nodeId}/live?from=latest`);
      for (const { record } of read.body.entries as { record: Event }[]) {
        if (record.t !== "fold") Y.applyUpdate(doc, fromBase64(record.u as string));
      }
    },
    scene: () => liveScene(doc),
  };
}

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text };
  return result.structuredContent as Record<string, unknown>;
}

async function saved(who: Person, nodeId: string) {
  const read = sceneFromJson(await (await stack.download(who.jar, nodeId)).text());
  if (!read.ok) throw new Error(read.error);
  return read.scene;
}

async function stream(who: Person, nodeId: string) {
  const doc = new Y.Doc();
  const read = await stack.api(who.jar, "GET", `/files/${nodeId}/live?from=latest`);
  for (const { record } of read.body.entries as { record: Event }[]) {
    if (record.t !== "fold") Y.applyUpdate(doc, fromBase64(record.u as string));
  }
  return liveScene(doc);
}

const find = (scene: Scene, text: string) => scene.elements.find((e) => e.text === text)!;

async function board(ops: CanvasOp[]) {
  const org = await stack.company(`canvas-live-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const made = applyCanvasOps({ elements: [] }, ops);
  if (!made.ok) throw new Error(made.error);
  const json = sceneToJson(made.scene);
  const node = await stack.upload(
    ana.jar,
    { space: "shared" },
    "Board",
    new TextEncoder().encode(json),
    CANVAS_TYPE,
  );
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  return { ana, agent, node, scene: made.scene };
}

const STICKIES: CanvasOp[] = [
  { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 } },
  { op: "add", kind: "sticky", text: "B", at: { x: 300, y: 0 } },
  { op: "add", kind: "sticky", text: "C", at: { x: 600, y: 0 } },
];

test("an agent's edit merges into what a tab is doing on the canvas, saved or not", async () => {
  const { ana, agent, node, scene } = await board(STICKIES);
  const a = find(scene, "A").id;
  const b = find(scene, "B").id;
  const open = await tab(ana.jar, node.id);
  await open.seed(scene, 1);
  await open.change([{ op: "move", ids: [a], to: { x: 40, y: 400 } }]).send();
  await open.change([{ op: "update", id: b, text: "B, typed in the tab" }]).send();

  const fetched = (await call(agent, "drive_fetch", { id: node.id })) as Record<
    string,
    Record<string, unknown>
  > & { text: string };
  expect(fetched.metadata).toMatchObject({ unsaved_edits: true });
  expect(fetched.text).toContain(`- sticky ${a} yellow [40,400 200×200] "A"`);
  expect(fetched.text).toContain(`- sticky ${b} yellow [300,0 200×200] "B, typed in the tab"`);
  expect(find(await saved(ana, node.id), "A").box).toEqual([0, 0, 200, 200]);

  const edited = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [
      { op: "update", id: a, color: "green" },
      { op: "update", id: b, text: "B, typed in the tab, and booked" },
      { op: "connect", from: a, to: b, ref: "line" },
    ],
  });
  expect(edited).not.toHaveProperty("error");
  const fold = await open.waitFor(
    (e) => e.type === "doc.record" && (e.record as Event).t === "fold",
  );
  expect(fold.record).toMatchObject({ t: "fold", cv: 2 });

  const after = await saved(ana, node.id);
  expect(find(after, "A")).toMatchObject({ box: [40, 400, 200, 200], color: "green" });
  expect(find(after, "B, typed in the tab, and booked")).toBeDefined();
  expect(after.elements.find((e) => e.kind === "connector")).toMatchObject({
    from: { id: a },
    to: { id: b },
  });
  await open.hear();
  expect(sceneToJson(open.scene())).toBe(sceneToJson(after));

  const versions = (await call(agent, "drive_versions", { id: node.id })) as {
    current: { agent: string };
  };
  expect(versions.current.agent).toBe("Drive agent");
  open.ws.close();
});

test("a tab and an agent moving the same sticky at once settle on one of the two moves, whole", async () => {
  const { ana, agent, node, scene } = await board(STICKIES);
  const c = find(scene, "C").id;
  const open = await tab(ana.jar, node.id);
  await open.seed(scene, 1);
  const tabMove = open.change([{ op: "move", ids: [c], to: { x: 900, y: 10 } }]);

  const moved = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "move", ids: [c], to: { x: 20, y: 900 } }],
  });
  expect(moved).not.toHaveProperty("error");
  await tabMove.send();

  const merged = await stream(ana, node.id);
  await open.hear();
  expect(sceneToJson(open.scene())).toBe(sceneToJson(merged));
  expect([
    [900, 10, 200, 200],
    [20, 900, 200, 200],
  ]).toContainEqual(find(merged, "C").box);
  open.ws.close();
});

test("a tab and an agent reordering different stickies at once both keep their move", async () => {
  const { ana, agent, node, scene } = await board(STICKIES);
  const [a, , c] = ["A", "B", "C"].map((text) => find(scene, text).id);
  const open = await tab(ana.jar, node.id);
  await open.seed(scene, 1);
  const front = open.change([{ op: "order", ids: [a!], to: "front" }]);

  const back = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "order", ids: [c!], to: "back" }],
  });
  expect(back).not.toHaveProperty("error");
  await front.send();

  const merged = await stream(ana, node.id);
  expect(merged.elements.map((e) => e.text)).toEqual(["C", "B", "A"]);
  await open.hear();
  expect(open.scene().elements.map((e) => e.text)).toEqual(["C", "B", "A"]);
  open.ws.close();
});

test("two tabs that take a board past its element limit together leave it readable, and an agent can still edit it", async () => {
  const full = Array.from({ length: 1_999 }, (_, i) => ({
    id: `s${i}`,
    kind: "sticky" as const,
    box: [(i % 100) * 10, Math.floor(i / 100) * 10, 10, 10] as [number, number, number, number],
  }));
  const org = await stack.company(`canvas-full-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const scene: Scene = { elements: full };
  const node = await stack.upload(
    ana.jar,
    { space: "shared" },
    "Full",
    new TextEncoder().encode(sceneToJson(scene)),
    CANVAS_TYPE,
  );
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const one = await tab(ana.jar, node.id);
  const epoch = await one.seed(scene, 1);
  const two = await tab(ana.jar, node.id);
  await two.join(epoch);
  const first = one.change([{ op: "add", kind: "sticky", text: "One", at: { x: 0, y: 600 } }]);
  const second = two.change([{ op: "add", kind: "sticky", text: "Two", at: { x: 300, y: 600 } }]);
  await first.send();
  await second.send();

  const edited = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "update", id: "s0", color: "pink" }],
  });
  expect(edited).not.toHaveProperty("error");
  const file = await saved(ana, node.id);
  expect(file.elements).toHaveLength(2_001);
  expect(find(file, "One")).toBeDefined();
  expect(file.elements.find((e) => e.id === "s0")).toMatchObject({ color: "pink" });

  const grown = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "add", kind: "sticky", text: "Three" }],
  });
  expect(grown).toMatchObject({ error: expect.stringContaining("this would make 2002") });
  one.ws.close();
  two.ws.close();
});

test("an agent's text change and a tab's typing in the same sticky both stay, even in the words between", async () => {
  const { ana, agent, node, scene } = await board([
    { op: "add", kind: "sticky", text: "A unchanged Z", at: { x: 0, y: 0 } },
  ]);
  const sticky = find(scene, "A unchanged Z").id;
  const open = await tab(ana.jar, node.id);
  await open.seed(scene, 1);
  const typing = open.change([{ op: "update", id: sticky, text: "A changed Z" }]);

  const edited = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "update", id: sticky, text: "B unchanged Y" }],
  });
  expect(edited).not.toHaveProperty("error");
  await typing.send();

  expect((await stream(ana, node.id)).elements[0]!.text).toBe("B changed Y");
  open.ws.close();
});

test("a sticky whose text concurrent edits take past the limit stays on the board", async () => {
  const long = "x".repeat(4_999);
  const { ana, agent, node, scene } = await board([
    { op: "add", kind: "sticky", text: long, at: { x: 0, y: 0 } },
  ]);
  const sticky = scene.elements[0]!.id;
  const open = await tab(ana.jar, node.id);
  await open.seed(scene, 1);
  const typing = open.change([{ op: "update", id: sticky, text: `A${long}` }]);

  const edited = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "update", id: sticky, text: `${long}Z` }],
  });
  expect(edited).not.toHaveProperty("error");
  await typing.send();

  expect((await stream(ana, node.id)).elements[0]?.text).toBe(`A${long}Z`);
  const recolored = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "update", id: sticky, color: "blue" }],
  });
  expect(recolored).not.toHaveProperty("error");
  const file = await saved(ana, node.id);
  expect(file.elements).toHaveLength(1);
  expect(file.elements[0]).toMatchObject({ id: sticky, color: "blue", text: `A${long}Z` });
  open.ws.close();
});

test("a whole-board rewrite leaves alone what it does not change, so a tab's move made meanwhile stays", async () => {
  const { ana, agent, node, scene } = await board(STICKIES);
  const a = find(scene, "A").id;
  const open = await tab(ana.jar, node.id);
  await open.seed(scene, 1);
  const drag = open.change([{ op: "move", ids: [a], to: { x: 0, y: 700 } }]);

  const rewritten = applyCanvasOps(scene, [
    { op: "update", id: find(scene, "C").id, text: "C, rewritten" },
  ]);
  if (!rewritten.ok) throw new Error(rewritten.error);
  const replaced = await call(agent, "drive_edit_canvas", {
    id: node.id,
    scene: sceneToJson(rewritten.scene),
  });
  expect(replaced).not.toHaveProperty("error");
  await drag.send();

  const merged = await stream(ana, node.id);
  expect(find(merged, "A").box).toEqual([0, 700, 200, 200]);
  expect(find(merged, "C, rewritten")).toBeDefined();
  expect(find(merged, "B").box).toEqual([300, 0, 200, 200]);
  open.ws.close();
});

test("two tabs that put two groups inside each other at once still read, and save, one valid board", async () => {
  const { ana, agent, node, scene } = await board([
    ...STICKIES,
    { op: "add", kind: "sticky", text: "D", at: { x: 900, y: 0 } },
  ]);
  const [a, b, c, d] = ["A", "B", "C", "D"].map((text) => find(scene, text).id);
  const grouped = applyCanvasOps(scene, [
    { op: "group", ids: [a!, b!], ref: "left" },
    { op: "group", ids: [c!, d!], ref: "right" },
  ]);
  if (!grouped.ok) throw new Error(grouped.error);
  const { left, right } = grouped.created;
  const one = await tab(ana.jar, node.id);
  const epoch = await one.seed(grouped.scene, 1);
  const two = await tab(ana.jar, node.id);
  await two.join(epoch);

  const nest = (doc: Y.Doc, child: string, parent: string) => {
    const now = liveScene(doc);
    const elements = now.elements.map((e) => (e.id === child ? { ...e, parent } : e));
    return base64(rewriteCanvas(doc, { elements }));
  };
  const first = nest(one.doc, left!, right!);
  const second = nest(two.doc, right!, left!);
  await one.append({ t: "update", e: epoch, u: first });
  await two.append({ t: "update", e: epoch, u: second });
  await one.hear();
  await two.hear();
  expect(sceneToJson(one.scene())).toBe(sceneToJson(two.scene()));

  const touched = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "update", id: a!, color: "pink" }],
  });
  expect(touched).not.toHaveProperty("error");
  const file = await saved(ana, node.id);
  const byId = new Map(file.elements.map((e) => [e.id, e]));
  for (const element of file.elements) {
    const seen = new Set<string>();
    for (let at = element.parent; at !== undefined; at = byId.get(at)?.parent) {
      expect(seen.has(at)).toBe(false);
      seen.add(at);
    }
  }
  expect([left, right].filter((id) => byId.get(id!)?.parent !== undefined)).toHaveLength(1);
  one.ws.close();
  two.ws.close();
});

test("a connector a tab joined to itself is freed where it is drawn, and an agent can still place things by it", async () => {
  const { ana, agent, node, scene } = await board(STICKIES);
  const loop: CanvasElement = {
    id: "loop",
    kind: "connector",
    from: { id: "loop", at: [0, 300] },
    to: { at: [200, 300] },
    route: "straight",
    end: "arrow",
  };
  const one = await tab(ana.jar, node.id);
  await one.seed({ elements: [...scene.elements, loop] }, 1);

  const placed = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "add", kind: "sticky", text: "Next", place: { near: "loop", side: "below" } }],
  });
  expect(placed).not.toHaveProperty("error");
  const file = await saved(ana, node.id);
  expect(file.elements.find((e) => e.id === "loop")).toMatchObject({
    from: { at: [0, 300] },
    to: { at: [200, 300] },
  });
  expect(file.elements.find((e) => e.id === "loop")!.from).not.toHaveProperty("id");
  expect(find(file, "Next").box).toEqual([0, 340, 200, 200]);
});

test("a board two tabs took past the body limit together can be shrunk by an agent, but not grown", async () => {
  const long = (label: string) => label.padEnd(4_900, ".");
  const base = Array.from({ length: 78 }, (_, i) => ({
    id: `s${i}`,
    kind: "sticky" as const,
    box: [(i % 10) * 300, Math.floor(i / 10) * 300, 200, 200] as [number, number, number, number],
    text: long(`s${i}`),
  }));
  const org = await stack.company(`canvas-heavy-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const scene: Scene = { elements: base };
  expect(sceneToJson(scene).length).toBeLessThan(CANVAS_MAX_BYTES);
  const node = await stack.upload(
    ana.jar,
    { space: "shared" },
    "Heavy",
    new TextEncoder().encode(sceneToJson(scene)),
    CANVAS_TYPE,
  );
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const one = await tab(ana.jar, node.id);
  const epoch = await one.seed(scene, 1);
  const two = await tab(ana.jar, node.id);
  await two.join(epoch);
  const adds = (who: string) =>
    [1, 2, 3].map(
      (n) => ({ op: "add", kind: "sticky", text: long(`${who}${n}`) }) satisfies CanvasOp,
    );
  const first = one.change(adds("one"));
  const second = two.change(adds("two"));
  await first.send();
  await second.send();
  expect(sceneToJson(await stream(ana, node.id)).length).toBeGreaterThan(CANVAS_MAX_BYTES + 10_000);

  const shrunk = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "delete", ids: ["s0"] }],
  });
  expect(shrunk).not.toHaveProperty("error");
  const file = await saved(ana, node.id);
  expect(sceneToJson(file).length).toBeGreaterThan(CANVAS_MAX_BYTES);
  expect(file.elements.find((e) => e.id === "s0")).toBeUndefined();

  const again = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "delete", ids: ["s1"] }],
  });
  expect(again).not.toHaveProperty("error");
  const grown = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "add", kind: "sticky", text: long("more") }],
  });
  expect(grown).toMatchObject({ error: expect.stringContaining("larger than 400 KB") });
  one.ws.close();
  two.ws.close();
});

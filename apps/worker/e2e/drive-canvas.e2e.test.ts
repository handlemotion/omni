import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { CANVAS_TYPE, sceneFromJson, sceneToJson, type CanvasElement } from "@omni/canvas";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off", RATE_LIMIT_ACTIONS: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const WRITE = "openid mail:read drive:read drive:write";

type Answer = Record<string, unknown> & { error?: string };

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text } as Answer;
  return result.structuredContent as Answer;
}

async function person() {
  const org = await stack.company(`canvas-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  return { ana, agent: await connectAgent(stack.worker.url, ana.jar, { scope: WRITE }) };
}

async function body(who: Person, nodeId: string) {
  const text = await (await stack.download(who.jar, nodeId)).text();
  const read = sceneFromJson(text);
  if (!read.ok) throw new Error(read.error);
  return { text, scene: read.scene };
}

const byText = (elements: CanvasElement[], text: string) =>
  elements.find((element) => element.text === text)!;

async function roofPlan(agent: Client) {
  const made = await call(agent, "drive_create_canvas", {
    name: "Roof repair",
    space: "shared",
    ops: [
      { op: "frame", title: "Q1 plan", ref: "plan" },
      { op: "add", kind: "sticky", text: "Call the roofer", parent: "plan", ref: "call" },
      {
        op: "add",
        kind: "sticky",
        text: "Order tiles",
        place: { near: "call", side: "right" },
        ref: "tiles",
      },
      { op: "move", ids: ["tiles"], into: "plan" },
      { op: "connect", from: "call", to: "tiles", text: "then", ref: "then" },
    ],
  });
  expect(made).not.toHaveProperty("error");
  return made as Answer & { canvas: { id: string }; created: Record<string, string> };
}

test("an agent's canvas is a canvas named without an extension, one element per line, its refs wired and kept after an edit", async () => {
  const { ana, agent } = await person();
  const made = await roofPlan(agent);
  expect(made.canvas).toMatchObject({ title: "Roof repair", mime_type: CANVAS_TYPE });
  const { plan, call: callId, tiles, then } = made.created;
  expect(Object.keys(made.created).toSorted()).toEqual(["call", "plan", "then", "tiles"]);

  const saved = await body(ana, made.canvas.id);
  expect(saved.text).toBe(sceneToJson(saved.scene));
  expect(saved.text.split("\n").filter((line) => line.startsWith('    {"id"'))).toHaveLength(4);
  expect(saved.scene.elements.map((element) => element.id)).toEqual([plan, callId, tiles, then]);
  expect(byText(saved.scene.elements, "then")).toMatchObject({
    kind: "connector",
    from: { id: callId },
    to: { id: tiles },
  });
  expect(byText(saved.scene.elements, "Order tiles")).toMatchObject({ parent: plan });

  const edited = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "update", id: tiles, text: "Order blue tiles", color: "blue" }],
  });
  expect(edited).toMatchObject({ canvas: { mime_type: CANVAS_TYPE, title: "Roof repair" } });
  expect(edited.changed).toBe(
    `# in frame ${plan} "Q1 plan"\n- sticky ${tiles} blue [280,80 200×200] "Order blue tiles"`,
  );

  const fetched = await call(agent, "drive_fetch", { id: made.canvas.id });
  expect(fetched.text).toBe(
    [
      `Canvas "Roof repair" · 4 elements · 1 frame · board 0,0 to 800,600`,
      `# frame ${plan} "Q1 plan" [0,0 800×600]`,
      `- sticky ${callId} yellow [40,80 200×200] "Call the roofer"`,
      `- sticky ${tiles} blue [280,80 200×200] "Order blue tiles"`,
      `- connector ${then} ${callId} → ${tiles} straight "then"`,
    ].join("\n"),
  );
});

test("an edit that misses changes nothing and answers with the canvas as it is now", async () => {
  const { ana, agent } = await person();
  const made = await roofPlan(agent);
  const before = await body(ana, made.canvas.id);

  const missed = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [
      { op: "update", id: made.created.call, text: "Call the roofer today" },
      { op: "delete", ids: ["nope"] },
    ],
  });
  expect(missed.error).toContain('Operation 2 (delete): No element "nope" on the canvas.');
  expect(missed.error).toContain(
    `- sticky ${made.created.call} yellow [40,80 200×200] "Call the roofer"`,
  );
  expect((await body(ana, made.canvas.id)).text).toBe(before.text);
});

test("an agent places things by their neighbours and is told when its layout collides", async () => {
  const { agent } = await person();
  const made = await roofPlan(agent);
  const { call: callId, tiles } = made.created;
  const edited = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [
      {
        op: "add",
        kind: "sticky",
        text: "Below",
        place: { near: callId, side: "below" },
        ref: "below",
      },
      { op: "add", kind: "sticky", text: "On top", at: { x: 300, y: 100 }, ref: "ontop" },
    ],
  });
  const { below, ontop } = edited.created as Record<string, string>;
  expect(edited.changed).toContain(`- sticky ${below} yellow [40,320 200×200] "Below"`);
  expect(edited.overlaps).toEqual([[ontop, tiles]]);
});

test("a canvas past its limits is refused whole", async () => {
  const { ana, agent } = await person();
  const made = await roofPlan(agent);
  const before = await body(ana, made.canvas.id);

  const many = Array.from({ length: 201 }, (_, i) => ({ op: "add", kind: "sticky", text: `${i}` }));
  const tooMany = await call(agent, "drive_edit_canvas", { id: made.canvas.id, ops: many });
  expect(tooMany.error).toBeDefined();

  const elements = Array.from({ length: 2_001 }, (_, i) => ({
    id: `s${i}`,
    kind: "sticky",
    box: [i * 10, 0, 10, 10],
  }));
  const huge = JSON.stringify({ omni: "canvas", v: 1, elements });
  const tooBig = await call(agent, "drive_edit_canvas", { id: made.canvas.id, scene: huge });
  expect(tooBig.error).toContain("A canvas holds at most 2000 elements; this would make 2001.");
  expect((await body(ana, made.canvas.id)).text).toBe(before.text);
});

test("deleting what a connector points at leaves the line where it was drawn", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Flow",
    ops: [
      { op: "add", kind: "sticky", text: "From", at: { x: 0, y: 0 }, ref: "from" },
      { op: "add", kind: "sticky", text: "To", at: { x: 400, y: 0 }, ref: "to" },
      { op: "connect", from: "from", to: "to", ref: "line" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const deleted = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "delete", ids: [made.created.to] }],
  });
  expect(deleted).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({
    from: { id: made.created.from, at: [200, 100] },
    to: { at: [400, 100] },
  });
  expect(line!.to).not.toHaveProperty("id");
});

test("an edit to a canvas whose nested groups thinned out keeps what was inside them", async () => {
  const { ana, agent } = await person();
  const json = JSON.stringify({
    omni: "canvas",
    v: 1,
    elements: [
      { id: "kept", kind: "sticky", parent: "inner", box: [0, 0, 200, 200], text: "Inside" },
      { id: "inner", kind: "group", parent: "outer" },
      { id: "outer", kind: "group" },
    ],
  });
  const node = await stack.upload(
    ana.jar,
    { space: "personal" },
    "Groups",
    new TextEncoder().encode(json),
    CANVAS_TYPE,
  );
  const edited = await call(agent, "drive_edit_canvas", {
    id: node.id,
    ops: [{ op: "update", id: "kept", color: "pink" }],
  });
  expect(edited).not.toHaveProperty("error");
  expect((await body(ana, node.id)).scene.elements).toEqual([
    { id: "kept", kind: "sticky", box: [0, 0, 200, 200], color: "pink", text: "Inside" },
  ]);
});

test("moving one end of a connector across the other redraws both ends", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Swap",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "connect", from: "a", to: "b" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const moved = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "move", ids: [made.created.b], to: { x: -400, y: 0 } }],
  });
  expect(moved).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({ from: { at: [0, 100] }, to: { at: [-200, 100] } });
});

test("a connector whose elements are gone moves by itself, and one still joined says to move what it joins", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Loose line",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "add", kind: "sticky", text: "C", at: { x: 0, y: 400 }, ref: "c" },
      { op: "connect", from: "a", to: "b", ref: "loose" },
      { op: "connect", from: "a", to: "c", ref: "joined" },
      { op: "delete", ids: ["b"] },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const id = made.canvas.id;
  const refused = await call(agent, "drive_edit_canvas", {
    id,
    ops: [{ op: "move", ids: [made.created.joined], by: { dx: 50, dy: 80 } }],
  });
  expect(refused.error).toContain("moves with the elements it joins");

  const cut = await call(agent, "drive_edit_canvas", {
    id,
    ops: [
      { op: "delete", ids: [made.created.a] },
      { op: "move", ids: [made.created.loose], by: { dx: 50, dy: 80 } },
    ],
  });
  expect(cut).not.toHaveProperty("error");
  const line = (await body(ana, id)).scene.elements.find((e) => e.id === made.created.loose);
  expect(line).toMatchObject({ from: { at: [250, 180] }, to: { at: [450, 180] } });
});

test("a connector bound to a group follows the group when one of its children moves", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Grouped",
    ops: [
      { op: "add", kind: "sticky", text: "One", at: { x: 0, y: 0 }, ref: "one" },
      { op: "add", kind: "sticky", text: "Two", at: { x: 300, y: 0 }, ref: "two" },
      { op: "group", ids: ["one", "two"], ref: "pair" },
      { op: "add", kind: "sticky", text: "Far", at: { x: 1200, y: 0 }, ref: "far" },
      { op: "connect", from: "pair", to: "far", ref: "line" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const before = (await body(ana, made.canvas.id)).scene.elements.find(
    (e) => e.kind === "connector",
  );
  expect(before).toMatchObject({ from: { at: [500, 100] } });
  const moved = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "move", ids: [made.created.two], by: { dx: 300, dy: 0 } }],
  });
  expect(moved).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({ from: { id: made.created.pair, at: [800, 100] } });
});

test("drive_fetch gives a long sticky's whole text", async () => {
  const { agent } = await person();
  const long = `${"Measure the roof, then the gutters. ".repeat(20)}End of note.`;
  const made = (await call(agent, "drive_create_canvas", {
    name: "Long note",
    ops: [{ op: "add", kind: "sticky", text: long }],
  })) as Answer & { canvas: { id: string } };
  const fetched = (await call(agent, "drive_fetch", { id: made.canvas.id })) as {
    text: string;
    metadata: { truncated: boolean };
  };
  expect(fetched.text).toContain(JSON.stringify(long));
  expect(fetched.metadata.truncated).toBe(false);
});

test("deleting a frame refuses while something inside it is locked", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Locked inside",
    ops: [
      { op: "frame", title: "Plan", ref: "plan" },
      { op: "add", kind: "sticky", text: "Keep", parent: "plan", ref: "keep" },
      { op: "update", id: "keep", locked: true },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const before = (await body(ana, made.canvas.id)).text;
  const deleted = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "delete", ids: [made.created.plan] }],
  });
  expect(deleted.error).toContain(`"${made.created.keep}" inside "${made.created.plan}" is locked`);
  expect((await body(ana, made.canvas.id)).text).toBe(before);
});

test("a group of loose connectors moves as one", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Loose lines",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "add", kind: "sticky", text: "C", at: { x: 0, y: 400 }, ref: "c" },
      { op: "connect", from: "a", to: "b", ref: "top" },
      { op: "connect", from: "a", to: "c", ref: "side" },
      { op: "delete", ids: ["a", "b", "c"] },
      { op: "group", ids: ["top", "side"], ref: "lines" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  expect(made).not.toHaveProperty("error");
  const moved = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "move", ids: [made.created.lines], to: { x: 1000, y: 1000 } }],
  });
  expect(moved).not.toHaveProperty("error");
  const lines = (await body(ana, made.canvas.id)).scene.elements.filter(
    (e) => e.kind === "connector",
  );
  expect(lines.map((line) => [line.from!.at, line.to!.at])).toEqual([
    [
      [1100, 1000],
      [1300, 1000],
    ],
    [
      [1000, 1100],
      [1000, 1300],
    ],
  ]);
});

test("deleting a group's child redraws connectors bound to the group", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Shrinking group",
    ops: [
      { op: "add", kind: "sticky", text: "1", at: { x: 0, y: 0 }, ref: "one" },
      { op: "add", kind: "sticky", text: "2", at: { x: 300, y: 0 }, ref: "two" },
      { op: "add", kind: "sticky", text: "3", at: { x: 600, y: 0 }, ref: "three" },
      { op: "group", ids: ["one", "two", "three"], ref: "row" },
      { op: "add", kind: "sticky", text: "Far", at: { x: 1400, y: 0 }, ref: "far" },
      { op: "connect", from: "row", to: "far" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const deleted = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "delete", ids: [made.created.three] }],
  });
  expect(deleted).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({ from: { id: made.created.row, at: [500, 100] } });
});

test("arranging a connector that still joins elements is refused and changes nothing", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Arrange",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "add", kind: "sticky", text: "C", at: { x: 800, y: 0 }, ref: "c" },
      { op: "connect", from: "a", to: "b", ref: "line" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const before = (await body(ana, made.canvas.id)).text;
  const arranged = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "arrange", ids: [made.created.c, made.created.line], as: "row" }],
  });
  expect(arranged.error).toContain("moves with the elements it joins");
  expect((await body(ana, made.canvas.id)).text).toBe(before);
});

test("moving a child out of a group redraws connectors bound to the group", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Leaving group",
    ops: [
      { op: "frame", title: "Elsewhere", ref: "frame" },
      { op: "add", kind: "sticky", text: "1", at: { x: 0, y: 1000 }, ref: "one" },
      { op: "add", kind: "sticky", text: "2", at: { x: 300, y: 1000 }, ref: "two" },
      { op: "add", kind: "sticky", text: "3", at: { x: 600, y: 1000 }, ref: "three" },
      { op: "group", ids: ["one", "two", "three"], ref: "row" },
      { op: "add", kind: "sticky", text: "Far", at: { x: 1400, y: 1000 }, ref: "far" },
      { op: "connect", from: "row", to: "far" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const moved = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "move", ids: [made.created.three], into: made.created.frame }],
  });
  expect(moved).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({ from: { id: made.created.row, at: [500, 1100] } });
});

test("arranging a group together with something inside it is refused and changes nothing", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Nested arrange",
    ops: [
      { op: "add", kind: "sticky", text: "C", at: { x: 0, y: 0 }, ref: "c" },
      { op: "add", kind: "sticky", text: "A", at: { x: 300, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 600, y: 0 }, ref: "b" },
      { op: "group", ids: ["a", "b"], ref: "pair" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const before = (await body(ana, made.canvas.id)).text;
  const arranged = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "arrange", ids: [made.created.c, made.created.pair, made.created.b], as: "row" }],
  });
  expect(arranged.error).toContain(`"${made.created.b}" is inside another element being arranged`);
  expect((await body(ana, made.canvas.id)).text).toBe(before);
});

test("moving one element across another and deleting that other in one call frees the line where it is drawn now", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Move then delete",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "connect", from: "a", to: "b" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const edited = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [
      { op: "move", ids: [made.created.b], to: { x: -400, y: 0 } },
      { op: "delete", ids: [made.created.a] },
    ],
  });
  expect(edited).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({
    from: { at: [0, 100] },
    to: { id: made.created.b, at: [-200, 100] },
  });
  expect(line!.from).not.toHaveProperty("id");
});

test("moving or arranging a group of lines that still join elements outside it is refused and changes nothing", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Joined lines",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "add", kind: "sticky", text: "C", at: { x: 0, y: 400 }, ref: "c" },
      { op: "add", kind: "sticky", text: "D", at: { x: 1000, y: 0 }, ref: "d" },
      { op: "connect", from: "a", to: "b", ref: "top" },
      { op: "connect", from: "a", to: "c", ref: "side" },
      { op: "group", ids: ["top", "side"], ref: "lines" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  expect(made).not.toHaveProperty("error");
  const before = (await body(ana, made.canvas.id)).text;
  const moved = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "move", ids: [made.created.lines], by: { dx: 500, dy: 0 } }],
  });
  expect(moved.error).toContain(`joins "${made.created.a}"`);
  const arranged = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "arrange", ids: [made.created.d, made.created.lines], as: "row" }],
  });
  expect(arranged.error).toContain(`joins "${made.created.a}"`);
  expect((await body(ana, made.canvas.id)).text).toBe(before);
});

test("a whole scene with a connector joined to itself is refused and changes nothing", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Self loop",
    ops: [{ op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 } }],
  })) as Answer & { canvas: { id: string } };
  const before = (await body(ana, made.canvas.id)).text;
  const loop = {
    id: "c",
    kind: "connector",
    from: { id: "c", at: [0, 0] },
    to: { at: [100, 0] },
    route: "straight",
    end: "arrow",
  };
  const scene = before.replace('"elements": [', `"elements": [\n    ${JSON.stringify(loop)},`);
  const replaced = await call(agent, "drive_edit_canvas", { id: made.canvas.id, scene });
  expect(replaced.error).toContain('The connector "c" is joined to a connector');
  expect((await body(ana, made.canvas.id)).text).toBe(before);
});

test("moving a group and ungrouping it in one call frees its lines where the group ended up", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Move then ungroup",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 300, y: 0 }, ref: "b" },
      { op: "group", ids: ["a", "b"], ref: "pair" },
      { op: "add", kind: "sticky", text: "C", at: { x: 1000, y: 0 }, ref: "c" },
      { op: "connect", from: "pair", to: "c" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  const edited = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [
      { op: "move", ids: [made.created.pair], by: { dx: 200, dy: 0 } },
      { op: "ungroup", id: made.created.pair },
    ],
  });
  expect(edited).not.toHaveProperty("error");
  const line = (await body(ana, made.canvas.id)).scene.elements.find((e) => e.kind === "connector");
  expect(line).toMatchObject({ from: { at: [700, 100] }, to: { id: made.created.c } });
  expect(line!.from).not.toHaveProperty("id");
});

test("a line bound to a moved group lands on the group's new edge whatever its paint order", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Group order",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 300, y: 0 }, ref: "b" },
      { op: "connect", from: "a", to: "b", ref: "inner" },
      { op: "group", ids: ["a", "b", "inner"], ref: "pair" },
      { op: "add", kind: "sticky", text: "C", at: { x: 1000, y: 0 }, ref: "c" },
      { op: "connect", from: "pair", to: "c", ref: "outer" },
      { op: "order", ids: ["outer"], to: "back" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  expect(made).not.toHaveProperty("error");
  const moved = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "move", ids: [made.created.pair], by: { dx: -1000, dy: 0 } }],
  });
  expect(moved).not.toHaveProperty("error");
  const { elements } = (await body(ana, made.canvas.id)).scene;
  expect(elements.find((e) => e.id === made.created.outer)).toMatchObject({
    from: { id: made.created.pair, at: [-500, 100] },
  });
});

test("arranging a group of lines together with the elements they join is refused and changes nothing", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Arrange joined",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 400, y: 0 }, ref: "b" },
      { op: "connect", from: "a", to: "b", ref: "there" },
      { op: "connect", from: "b", to: "a", ref: "back" },
      { op: "group", ids: ["there", "back"], ref: "lines" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  expect(made).not.toHaveProperty("error");
  const before = (await body(ana, made.canvas.id)).text;
  const arranged = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [{ op: "arrange", ids: [made.created.lines, made.created.a, made.created.b], as: "row" }],
  });
  expect(arranged.error).toMatch(/joins "(.+)": move/);
  expect((await body(ana, made.canvas.id)).text).toBe(before);
});

test("placing something beside a group moved earlier in the same call uses where the group is now", async () => {
  const { ana, agent } = await person();
  const made = (await call(agent, "drive_create_canvas", {
    name: "Move then place",
    ops: [
      { op: "add", kind: "sticky", text: "A", at: { x: 0, y: 0 }, ref: "a" },
      { op: "add", kind: "sticky", text: "B", at: { x: 300, y: 0 }, ref: "b" },
      { op: "connect", from: "a", to: "b", ref: "inner" },
      { op: "group", ids: ["a", "b", "inner"], ref: "pair" },
    ],
  })) as Answer & { canvas: { id: string }; created: Record<string, string> };
  expect(made).not.toHaveProperty("error");
  const edited = await call(agent, "drive_edit_canvas", {
    id: made.canvas.id,
    ops: [
      { op: "move", ids: [made.created.pair], by: { dx: -1000, dy: 0 } },
      {
        op: "add",
        kind: "sticky",
        text: "Next",
        place: { near: made.created.pair, side: "right" },
      },
    ],
  });
  expect(edited).not.toHaveProperty("error");
  const { elements } = (await body(ana, made.canvas.id)).scene;
  expect(byText(elements, "Next").box).toEqual([-460, 0, 200, 200]);
});

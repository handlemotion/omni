import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { LiveParts, type StorageLiveEntry } from "@omni/contracts";
import type { StorageNode } from "@omni/db";
import {
  applySheetEdits,
  fillDoc,
  parseSheet,
  SHEET_TYPE,
  sheetMaps,
  readGrid,
} from "@omni/sheets";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { pushFrame, WEB_ORIGIN, type CookieJar } from "./support.ts";

const S2 = { url: "http://127.0.0.1:54380/v1", basin: "omni-docs-dev" };
const WRITE = "openid mail:read drive:read drive:write";

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

type Answer = Record<string, unknown> & { error?: string };

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text } as Answer;
  return result.structuredContent as Answer;
}

const fileText = async (person: Person, id: string) =>
  (await stack.download(person.jar, id)).text();
const base64 = (update: Uint8Array) => Buffer.from(update).toString("base64");

type Event = Record<string, unknown>;

async function editor(jar: CookieJar, nodeId: string) {
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Event[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    pushFrame(received, e.data);
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
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  socket.send(JSON.stringify({ type: "file.presence", nodeId, state: "editing" }));
  let ref = 0;
  const append = async (record: Event, matchSeqNum?: number) => {
    for (;;) {
      const sent = ++ref;
      socket.send(JSON.stringify({ type: "doc.append", nodeId, ref: sent, record, matchSeqNum }));
      const answer = await waitFor(
        (e) => (e.type === "doc.appended" || e.type === "doc.refused") && e.ref === sent,
      );
      if (answer.type === "doc.appended") return answer.seqNum as number;
      if (answer.reason !== "editing") throw new Error(`refused: ${String(answer.reason)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { socket, received, append, waitFor };
}

const leads = {
  name: "Leads",
  frozen_rows: 1,
  rows: [
    ["Company", "Amount", "With tax"],
    ["Acme", 1200, "=B2*1.16"],
    ["Beta", 900, "=B3*1.16"],
  ],
  columns: [null, { type: "number", format: { kind: "currency", currency: "MXN" } }],
};

test("an agent writes a sheet and edits it by cell and range, only where its person may", async () => {
  const acme = await stack.company(`sheets-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(acme.id);
  const carl = await stack.member(acme.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });

  const made = await call(agent, "drive_create_sheet", {
    name: "Pipeline",
    workspace: acme.id,
    tabs: [leads],
  });
  expect(made).not.toHaveProperty("error");
  const sheet = made.sheet as { id: string; title: string };
  expect(sheet.title).toBe("Pipeline");
  const mine = await stack.api(ana.jar, "GET", "/nodes?space=personal");
  expect((mine.body.nodes as StorageNode[]).find((n) => n.id === sheet.id)).toMatchObject({
    name: "Pipeline",
    mimeType: SHEET_TYPE,
  });
  expect(await fileText(ana, sheet.id)).toContain('{"f":"=B2*1.16","v":1392}');

  const fetched = await call(agent, "drive_fetch", { id: sheet.id });
  expect(fetched.text).toBe(
    [
      "--- Sheet: Leads (A1:C3, frozen 1 row) ---",
      "\tA\tB\tC",
      "1\tCompany\tAmount\tWith tax",
      "2\tAcme\t1200\t1392",
      "3\tBeta\t900\t1044",
      "Formulas:",
      "C2:C3 =B2*1.16",
      "Columns: B number (currency MXN)",
      "",
    ].join("\n"),
  );
  const layout = (fetched.metadata as { layout: string }).layout;
  expect(layout).toBe(made.layout);

  const edited = await call(agent, "drive_edit_sheet", {
    id: sheet.id,
    layout,
    edits: [
      { set: "B2", value: 1400 },
      { append: [["Gamma", 500]] },
      { fill_down: "C3:C4" },
      { set: "A6:B6", values: [["Total", "=SUM(B2:B4)"]] },
    ],
  });
  expect(edited).not.toHaveProperty("error");
  expect(edited.changed).toEqual(["Leads!B2", "Leads!A4:B4", "Leads!C3:C4", "Leads!A6:B6"]);
  expect(edited.values).toContain("Leads!C4 = 580");
  expect(edited.values).toContain("Leads!B6 = 2800");
  const saved = parseSheet(await fileText(ana, sheet.id));
  expect(saved.tabs[0]!.rows).toHaveLength(6);
  expect((await stack.api(ana.jar, "GET", "/nodes?space=personal")).body.nodes).toContainEqual(
    expect.objectContaining({ id: sheet.id, mimeType: SHEET_TYPE }),
  );

  const stale = await call(agent, "drive_edit_sheet", {
    id: sheet.id,
    layout,
    edits: [{ set: "B2", value: 1 }],
  });
  expect(stale.error).toContain("Rows or columns moved since you read the sheet");
  expect(stale.error).toContain("2\tAcme\t1400\t1624");

  const missed = await call(agent, "drive_edit_sheet", {
    id: sheet.id,
    edits: [
      { set: "B2", value: 2 },
      { tab: "Nope", set: "A1", value: 1 },
    ],
  });
  expect(missed.error).toContain("Edit 2: there is no tab named Nope");
  expect(parseSheet(await fileText(ana, sheet.id)).tabs[0]!.rows[1]!.cells).toMatchObject(
    Object.fromEntries([[saved.tabs[0]!.columns[1]!.id, 1400]]),
  );

  const huge = await call(agent, "drive_edit_sheet", {
    id: sheet.id,
    edits: [
      { insert_columns: { after: "C", count: 50 } },
      { insert_columns: { after: "C", count: 50 } },
      { insert_columns: { after: "C", count: 50 } },
      { insert_columns: { after: "C", count: 50 } },
    ],
  });
  expect(huge.error).toContain("at most 200 columns");

  const oversized = await call(agent, "drive_create_sheet", {
    name: "Too big",
    workspace: acme.id,
    tabs: [{ name: "T", rows: [Array.from({ length: 160 }, () => '=REPT("x", 32767)')] }],
  });
  expect(oversized.error).toContain("larger than 5 MB");
  const twins = await call(agent, "drive_create_sheet", {
    name: "Twins",
    workspace: acme.id,
    tabs: [
      { name: "Leads", rows: [] },
      { name: "leads", rows: [] },
    ],
  });
  expect(twins.error).toContain("two tabs named leads");

  const carlAgent = await connectAgent(stack.worker.url, carl.jar, { scope: WRITE });
  expect(
    await call(carlAgent, "drive_edit_sheet", {
      id: sheet.id,
      edits: [{ set: "A1", value: "mine" }],
    }),
  ).toHaveProperty("error");

  const doc = await stack.upload(ana.jar, { space: "personal" }, "notes.txt", new Uint8Array(3));
  expect(
    (await call(agent, "drive_edit_sheet", { id: doc.id, edits: [{ set: "A1", value: 1 }] })).error,
  ).toContain("not an Omni sheet");

  const listed = await call(agent, "drive_versions", { id: sheet.id });
  const [first] = listed.versions as { id: string }[];
  const compared = await call(agent, "drive_versions", { id: sheet.id, version_id: first!.id });
  expect(compared.diff).toContain("Leads!B2: 1200 → 1400");
  expect(compared.diff).toContain("Leads: row 4 added");
  expect(compared.text).toContain("2\tAcme\t1200\t1392");

  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");
  const found = (await call(agent, "drive_search", { query: "Gamma" })) as {
    results: { id: string }[];
  };
  expect(found.results.map((r) => r.id)).toContain(sheet.id);
});

test("an agent's edit merges into a sheet people have open: their unsaved typing is kept, they hear the change, and a stale layout is refused", async () => {
  const acme = await stack.company(`live-sheets-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(acme.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const made = await call(agent, "drive_create_sheet", {
    name: "Live",
    workspace: acme.id,
    space: "shared",
    tabs: [leads],
  });
  const id = (made.sheet as { id: string }).id;

  const tab = await editor(ana.jar, id);
  const typing = new Y.Doc();
  fillDoc(typing, parseSheet(await fileText(ana, id)));
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(Y.encodeStateAsUpdate(typing)) }, 0);
  const typed = applySheetEdits(typing, [{ set: "A3", value: "Beta Corp" }], 46_000);
  if (!typed.ok) throw new Error(typed.error);
  await tab.append({ t: "update", e: epoch, u: base64(typed.update) });

  const fetched = await call(agent, "drive_fetch", { id });
  expect(fetched.text).toContain("3\tBeta Corp\t900\t1044");
  expect(fetched.metadata).toMatchObject({ unsaved_edits: true });
  const layout = (fetched.metadata as { layout: string }).layout;

  const inserted = applySheetEdits(typing, [{ insert_rows: { before: 2 } }], 46_000);
  if (!inserted.ok) throw new Error(inserted.error);
  await tab.append({ t: "update", e: epoch, u: base64(inserted.update) });
  const stale = await call(agent, "drive_edit_sheet", {
    id,
    layout,
    edits: [{ set: "B2", value: 1 }],
  });
  expect(stale.error).toContain("Rows or columns moved");

  const now = await call(agent, "drive_fetch", { id });
  const edited = await call(agent, "drive_edit_sheet", {
    id,
    layout: (now.metadata as { layout: string }).layout,
    edits: [{ set: "A2:B2", values: [["Delta", 300]] }],
  });
  expect(edited).not.toHaveProperty("error");
  expect(edited.values).toContain("Leads!B2 = 300");

  const saved = parseSheet(await fileText(ana, id));
  const names = saved.tabs[0]!.rows.map((row) => row.cells[saved.tabs[0]!.columns[0]!.id]);
  expect(names).toEqual(["Company", "Delta", "Acme", "Beta Corp"]);

  await tab.waitFor((e) => e.type === "doc.record" && (e.record as Event).t === "fold");
  const joiner = new LiveParts();
  for (const e of tab.received.filter((event) => event.type === "doc.record")) {
    const whole = joiner.push({ seqNum: e.seqNum, record: e.record } as StorageLiveEntry);
    if (whole?.record.t === "update") Y.applyUpdate(typing, Buffer.from(whole.record.u, "base64"));
  }
  const grid = readGrid(typing);
  const first = grid.tabs[0]!;
  expect(first.rows.map((row) => row.cells.get(first.columns[0]!.id))).toEqual(names);
  expect(sheetMaps(typing).rows.size).toBe(4);

  const versions = await call(agent, "drive_versions", { id });
  expect(versions.current).toMatchObject({ agent: "Drive agent" });
  tab.socket.close();
});

test("two agents adding the same tab to a sheet people have open at once never save it with two tabs of one name", async () => {
  const acme = await stack.company(`same-tab-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(acme.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const made = await call(agent, "drive_create_sheet", {
    name: "Plan",
    workspace: acme.id,
    space: "shared",
    tabs: [leads],
  });
  const id = (made.sheet as { id: string }).id;
  const tab = await editor(ana.jar, id);
  const typing = new Y.Doc();
  fillDoc(typing, parseSheet(await fileText(ana, id)));
  await tab.append({ t: "seed", cv: 1, u: base64(Y.encodeStateAsUpdate(typing)) }, 0);

  const other = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const both = await Promise.all(
    [agent, other].map((a) => call(a, "drive_edit_sheet", { id, edits: [{ add_tab: "Q3" }] })),
  );
  const refused = both.filter((answer) => "error" in answer);
  expect(refused.length).toBeGreaterThan(0);
  for (const answer of refused)
    expect(answer.error).toMatch(/two tabs named Q3|past a sheet's limits/);
  const saved = parseSheet(await fileText(ana, id));
  const names = saved.tabs.map((t) => t.name);
  expect(names).toEqual(refused.length === 1 ? ["Leads", "Q3"] : ["Leads"]);
  tab.socket.close();
});

test("when the live layer cannot be reached, an agent still reads a sheet as its file saved it, beside other files", async () => {
  const down = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_ACTIONS: "off",
      S2_BASIN_URL: "http://127.0.0.1:9/v1",
      S2_BASIN: S2.basin,
    },
  });
  try {
    const acme = await down.company(`s2-down-${randomUUID().slice(0, 8)}`);
    const ana = await down.member(acme.id);
    const agent = await connectAgent(down.worker.url, ana.jar, { scope: WRITE });
    const made = await call(agent, "drive_create_sheet", {
      name: "Offline",
      workspace: acme.id,
      tabs: [leads],
    });
    const id = (made.sheet as { id: string }).id;
    const note = await down.upload(
      ana.jar,
      { space: "personal" },
      "note.txt",
      new TextEncoder().encode("hello"),
    );
    const fetched = await call(agent, "drive_fetch", { id, ids: [note.id] });
    expect(fetched).not.toHaveProperty("error");
    expect(fetched.text).toContain("2\tAcme\t1200\t1392");
    expect(fetched.metadata).not.toHaveProperty("unsaved_edits");
    expect((fetched.more as { id: string }[]).map((f) => f.id)).toEqual([note.id]);
  } finally {
    await down.stop();
  }
});

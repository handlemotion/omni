import type { Client } from "@modelcontextprotocol/client";
import { PDFDocument, StandardFonts } from "pdf-lib";
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

// oxlint-disable-next-line typescript/no-explicit-any -- test reads of tool answers
type Answer = any;

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  const answer: Answer = result.isError
    ? { error: (result.content as { text: string }[])[0]!.text }
    : result.structuredContent;
  return answer;
}

async function pdf(pages: string[]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) document.addPage().drawText(text, { x: 50, y: 700, size: 12, font });
  return document.save();
}

async function setUp(name: string) {
  const acme = await stack.company(name);
  const ana = await stack.member(acme.id);
  const space = await stack.api(ana.jar, "POST", "/teamspaces", { name: "Ana", private: true });
  const teamspaceId = (space.body.teamspace as { id: string }).id;
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  return { ana, teamspaceId, agent };
}

test("an agent reads only the pages it asks for, and reads on from where a long text was cut", async () => {
  const { ana, teamspaceId, agent } = await setUp("acme-pages");
  const report = await stack.upload(
    ana.jar,
    { teamspaceId },
    "report.pdf",
    await pdf(["Intro to the plan", "Budget is ninety thousand", "Risks and dates"]),
    "application/pdf",
  );
  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");

  const two = await call(agent, "drive_fetch", { id: report.id, pages: "2-3" });
  expect(two.text).toContain("--- Page 2 ---");
  expect(two.text).toContain("Budget is ninety thousand");
  expect(two.text).toContain("Risks and dates");
  expect(two.text).not.toContain("Intro to the plan");
  expect((await call(agent, "drive_fetch", { id: report.id, pages: "two" })).error).toContain(
    "pages",
  );

  const long = Array.from({ length: 900 }, (_, i) => `line ${String(i).padStart(4, "0")}`).join(
    "\n",
  );
  const notes = await call(agent, "drive_upload", {
    name: "long.txt",
    teamspace_id: teamspaceId,
    text: long,
  });
  const first = await call(agent, "drive_fetch", { id: notes.file.id, max_chars: 2_000 });
  expect(first.metadata).toMatchObject({
    text_status: "ok",
    truncated: true,
    total_chars: long.length,
  });
  const next = first.metadata.next_offset;
  expect(first.text).toContain(`Read on with offset ${next}`);
  expect(long.startsWith(first.text.slice(0, next))).toBe(true);
  const second = await call(agent, "drive_fetch", {
    id: notes.file.id,
    max_chars: 2_000,
    offset: next,
  });
  expect(second.text.startsWith(long.slice(next, next + 100))).toBe(true);

  const unpaged = await call(agent, "drive_fetch", {
    id: notes.file.id,
    max_chars: 2_000,
    pages: "1",
  });
  const note = "[This file has no pages or slides: all of it.]\n";
  expect(unpaged.text.startsWith(note)).toBe(true);
  const read = unpaged.text.slice(note.length, unpaged.text.lastIndexOf("\n[Cut here."));
  expect(read).toBe(long.slice(0, unpaged.metadata.next_offset));

  const huge = await call(agent, "drive_fetch", { id: report.id, pages: "9007199254740992" });
  expect(huge.error).toContain("pages");
});

test("an agent reads a text file it just wrote, before the indexer has", async () => {
  const { teamspaceId, agent } = await setUp("acme-fresh");
  const made = await call(agent, "drive_upload", {
    name: "todo.md.txt",
    teamspace_id: teamspaceId,
    text: "- call Ana\n- send the deck",
  });
  const read = await call(agent, "drive_fetch", { id: made.file.id });
  expect(read).toMatchObject({
    text: "- call Ana\n- send the deck",
    metadata: { text_status: "ok" },
  });
});

test("an agent lists a folder tree in one call, cut where it is too large", async () => {
  const { teamspaceId, agent } = await setUp("acme-tree");
  const built = await call(agent, "drive_organize", {
    changes: [
      { action: "create_folder", name: "Clients", teamspace_id: teamspaceId, ref: "c" },
      { action: "create_folder", name: "Acme", folder_id: "c", ref: "a" },
      { action: "create_folder", name: "2026", folder_id: "a", ref: "y" },
      { action: "create_folder", name: "Globex", folder_id: "c" },
    ],
  });
  const clients = built.results[0].item.id;
  await call(agent, "drive_upload", {
    name: "brief.txt",
    folder_id: built.results[2].item.id,
    text: "x",
  });

  const shallow = await call(agent, "drive_list", { folder_id: clients });
  expect(shallow.items.map((i: Answer) => i.title)).toEqual(["Acme", "Globex"]);
  const deep = await call(agent, "drive_list", { folder_id: clients, depth: 3 });
  expect(deep.items.map((i: Answer) => `${i.location} / ${i.title}`)).toEqual([
    "Shared / Clients / Acme",
    "Shared / Clients / Globex",
    "Shared / Clients / Acme / 2026",
    "Shared / Clients / Acme / 2026 / brief.txt",
  ]);
  expect(deep).not.toHaveProperty("cut");
  const two = await call(agent, "drive_list", { folder_id: clients, depth: 2, limit: 1 });
  expect(two.items.map((i: Answer) => i.title)).toEqual(["Acme", "2026"]);
  expect(two.cut).toBe(true);
});

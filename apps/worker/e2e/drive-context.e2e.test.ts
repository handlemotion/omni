import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import type { StorageNode, StorageUpload } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off", RATE_LIMIT_SEARCH: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const DRIVE = "openid mail:read drive:read";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function pdf(pages: string[]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) document.addPage().drawText(text, { x: 50, y: 700, size: 12, font });
  return document.save();
}

function docx(paragraphs: string[]) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

function xlsx(rows: string[][]) {
  const strings = rows.flat();
  const sheet = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((_, c) => `<c t="s"><v>${strings.indexOf(row[c]!)}</v></c>`).join("")}</row>`,
    )
    .join("");
  return zipSync({
    "xl/workbook.xml": strToU8(
      '<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>',
    ),
    "xl/sharedStrings.xml": strToU8(
      `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
  });
}

const text = (value: string) => new TextEncoder().encode(value);

interface Item {
  id: string;
  title: string;
  url: string;
  location: string;
  snippet?: string;
}

interface Fetched {
  id: string;
  text: string;
  url: string;
  metadata: { text_status: string; location: string };
  more?: Fetched[];
  not_found?: string[];
}

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text };
  return result.structuredContent as Record<string, unknown>;
}

async function search(agent: Client, query: string) {
  const found = (await call(agent, "drive_search", { query })) as { results: Item[] };
  return found.results;
}

const titles = (items: Item[]) => items.map((item) => item.title).toSorted();

async function indexAll() {
  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");
}

async function agentFor(person: Person, scope = DRIVE) {
  return connectAgent(stack.worker.url, person.jar, { scope });
}

test("an agent finds and reads files by the words inside them, and only files its person can open", async () => {
  const word = `zephyr${randomUUID().slice(0, 6)}`;
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const carl = await stack.member(acme.id);
  const other = await stack.company("other");
  const bea = await stack.member(other.id);

  const report = await stack.upload(
    ana.jar,
    { space: "personal" },
    "report.pdf",
    await pdf(["Cover page", `Quarterly revenue forecast for ${word} grows nine percent`]),
    PDF,
  );
  const plan = await stack.upload(
    ana.jar,
    { space: "shared" },
    "plan.docx",
    docx(["Launch plan", `The ${word} launch needs a checklist`]),
    DOCX,
  );
  await stack.upload(
    ana.jar,
    { space: "personal" },
    "budget.xlsx",
    xlsx([
      ["Line", "Cost"],
      [`${word} ads`, "1200"],
    ]),
    XLSX,
  );
  await stack.upload(bea.jar, { space: "personal" }, "bea.md", text(`Bea's own ${word} notes`));
  await indexAll();

  const anaAgent = await agentFor(ana);
  const anaHits = await search(anaAgent, word);
  expect(titles(anaHits)).toEqual(["budget.xlsx", "plan.docx", "report.pdf"]);
  expect(anaHits.find((hit) => hit.id === report.id)?.snippet).toContain(`**${word}**`);

  const read = (await call(anaAgent, "drive_fetch", {
    id: report.id,
    ids: [plan.id],
  })) as unknown as Fetched;
  expect(read.text).toMatch(/--- Page 2 ---\nQuarterly revenue forecast/);
  expect(read.url).toBe(`${WEB_ORIGIN}/${acme.slug}/files/my?file=${report.id}`);
  expect(read.more?.[0]?.text).toContain(`The ${word} launch needs a checklist`);
  expect(read.more?.[0]?.metadata.location).toBe("Shared");

  const carlAgent = await agentFor(carl);
  expect(titles(await search(carlAgent, word))).toEqual(["plan.docx"]);
  expect(await call(carlAgent, "drive_fetch", { id: report.id })).toHaveProperty("error");

  const beaAgent = await agentFor(bea);
  expect(titles(await search(beaAgent, word))).toEqual(["bea.md"]);
  const shared = await stack.api(
    ana.jar,
    "PUT",
    `/nodes/${report.id}/sharing/people/${encodeURIComponent(bea.email)}`,
    { role: "viewer" },
  );
  expect(shared.status).toBe(200);
  const beaHits = await search(beaAgent, word);
  expect(titles(beaHits)).toEqual(["bea.md", "report.pdf"]);
  expect(beaHits.find((hit) => hit.id === report.id)?.location).toBe("Shared with you");
  const beaRead = (await call(beaAgent, "drive_fetch", { id: report.id })) as unknown as Fetched;
  expect(beaRead.text).toContain(`forecast for ${word}`);

  const clients = await stack.api(ana.jar, "POST", "/folders", {
    name: "Clients",
    space: "personal",
  });
  const nested = await stack.upload(
    ana.jar,
    { parentId: clients.body.node.id },
    "brief.md",
    text(`Nested ${word} brief`),
  );
  const folderShare = await stack.api(
    ana.jar,
    "PUT",
    `/nodes/${clients.body.node.id}/sharing/people/${encodeURIComponent(bea.email)}`,
    { role: "viewer" },
  );
  await indexAll();
  const nestedHit = (await search(beaAgent, word)).find((hit) => hit.id === nested.id);
  expect(nestedHit?.url).toBe(
    `${WEB_ORIGIN}/s/${folderShare.body.sharing.shareId}?file=${nested.id}`,
  );

  expect((await stack.api(ana.jar, "DELETE", `/nodes/${plan.id}`)).status).toBe(200);
  expect(await search(carlAgent, word)).toEqual([]);
  expect(await call(carlAgent, "drive_fetch", { id: plan.id })).toHaveProperty("error");

  expect(titles(await search(anaAgent, word))).toContain("brief.md");
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${clients.body.node.id}`)).status).toBe(200);
  expect(titles(await search(anaAgent, word))).not.toContain("brief.md");
  expect(titles(await search(beaAgent, word))).not.toContain("brief.md");
});

test("a replaced file is read again, and a token without drive:read is asked to step up", async () => {
  const org = await stack.company("versions");
  const ana = await stack.member(org.id);
  const before = `before${randomUUID().slice(0, 6)}`;
  const after = `after${randomUUID().slice(0, 6)}`;
  const note = await stack.upload(
    ana.jar,
    { space: "personal" },
    "note.md",
    text(`Draft ${before}`),
  );
  await indexAll();
  const agent = await agentFor(ana);
  expect(titles(await search(agent, before))).toEqual(["note.md"]);

  const body = text(`Final ${after}`);
  const opened = await stack.api(ana.jar, "POST", `/files/${note.id}/versions`, {
    size: body.length,
    mimeType: "text/markdown",
  });
  const upload = opened.body.upload as StorageUpload;
  expect((await stack.putPart(ana.jar, upload.id, 1, body)).status).toBe(200);
  const done = await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`);
  expect((done.body.node as StorageNode).contentVersion).toBe(2);

  const pending = (await call(agent, "drive_fetch", { id: note.id })) as unknown as Fetched;
  expect(pending.metadata.text_status).toBe("pending");
  expect(await search(agent, before)).toEqual([]);
  await indexAll();
  expect(await search(agent, before)).toEqual([]);
  expect(titles(await search(agent, after))).toEqual(["note.md"]);
  const [row] = await stack.db
    .select({ contentVersion: schema.storageTexts.contentVersion })
    .from(schema.storageTexts)
    .where(eq(schema.storageTexts.nodeId, note.id));
  expect(row?.contentVersion).toBe(2);

  const mailOnly = await agentFor(ana, "openid mail:read");
  await expect(
    mailOnly.callTool({ name: "drive_search", arguments: { query: after } }),
  ).rejects.toThrow(/403|insufficient_scope|drive:read/);
});

test("an agent pages through a folder whose names are not Latin", async () => {
  const org = await stack.company("paging");
  const ana = await stack.member(org.id);
  for (const name of ["日本.md", "💡ideas.md", "ñandú.md"]) {
    await stack.upload(ana.jar, { space: "personal" }, name, text(name));
  }
  const agent = await agentFor(ana);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const listed = (await call(agent, "drive_list", {
      workspace: org.id,
      space: "my_files",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    })) as { items: Item[]; next_cursor?: string };
    seen.push(...listed.items.map((item) => item.title));
    cursor = listed.next_cursor;
    if (!cursor) break;
  }
  expect(seen.toSorted()).toEqual(["ñandú.md", "日本.md", "💡ideas.md"].toSorted());
});

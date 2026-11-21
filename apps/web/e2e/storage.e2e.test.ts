import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, schema } from "@omni/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { utils, write, type WorkSheet } from "xlsx";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

const DOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;
let context: BrowserContext | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
  });
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("a file larger than one part uploads from the page and downloads byte for byte", async () => {
  const page = await signedIn(`files-${Date.now()}@gmail.test`, "/files/my");

  const bytes = randomBytes(2 * 16 * 1024 * 1024 + 1234);
  const parts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") parts.push(request.url().split("/parts/")[1] ?? "");
  });
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "footage.bin", mimeType: "application/octet-stream", buffer: bytes });
  await page.getByRole("row", { name: /footage\.bin/ }).waitFor({ timeout: 60_000 });
  expect(parts.toSorted()).toEqual(["1", "2", "3"]);

  await page.getByRole("button", { name: "Actions for footage.bin" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("footage.bin");
  const saved = await readFile(await download.path());
  expect(saved.byteLength).toBe(bytes.byteLength);
  expect(sha256(saved)).toBe(sha256(bytes));
});

test("a doc exported as Word keeps its headings, to-dos, marks, table and images", async () => {
  const page = await signedIn(`word-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: DOT_PNG });
  await page.getByRole("row", { name: /dot\.png/ }).waitFor({ timeout: 30_000 });
  const [dot] = await db
    .select({ id: schema.storageNodes.id })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "dot.png"));
  const text =
    "# Plan\n\nShip **soon**.\n\n- [x] Draft\n- [ ] Review\n\n| Who | When |\n| --- | --- |\n| Ana | Monday |\n\n```\nfirst();\n\nthird();\n```\n\nUp\\\n\\\nDown\n\n1. Step\n   - Aside\n\nThen\n\n4. Fourth\n" +
    `\n![dot](/api/storage/files/${dot?.id}/content)\n`;
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "export.md", mimeType: "text/markdown", buffer: Buffer.from(text) });
  await page.getByRole("row", { name: /export\.md/ }).waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Actions for export.md" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Export as Word" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("export.docx");
  const files = unzipSync(new Uint8Array(await readFile(await download.path())));
  const xml = strFromU8(files["word/document.xml"] ?? new Uint8Array());
  const paragraphs = xml.split("</w:p>");
  const holding = (words: string) => paragraphs.find((p) => p.includes(words)) ?? "";
  expect(holding(">Plan<")).toContain('w:val="Heading1"');
  expect(holding(">soon<")).toMatch(/<w:b\/>[\s\S]*>soon</);
  expect(xml).toContain("☑ ");
  expect(holding(">Review<")).toContain("☐ ");
  const table = xml.slice(xml.indexOf("<w:tbl>"), xml.indexOf("</w:tbl>"));
  for (const cell of ["Who", "When", "Ana", "Monday"]) expect(table).toContain(`>${cell}<`);
  expect(holding(">Up<")).toMatch(/>Up<[\s\S]*<w:br\/>[\s\S]*<w:br\/>[\s\S]*>Down</);
  const numId = (words: string) => /<w:numId w:val="(\d+)"/.exec(holding(words))?.[1];
  expect(numId(">Aside<")).toBeDefined();
  expect(numId(">Aside<")).not.toBe(numId(">Step<"));
  const numbering = strFromU8(files["word/numbering.xml"] ?? new Uint8Array());
  expect(numbering).toContain('<w:start w:val="4"/>');
  expect(holding(">first();<")).toMatch(
    />first\(\);<[\s\S]*<w:br\/>[\s\S]*<w:br\/>[\s\S]*>third\(\);</,
  );
  expect(Object.keys(files).some((name) => name.startsWith("word/media/"))).toBe(true);
});

test("a link open to anyone downloads its file, byte for byte, for someone signed out", async () => {
  const page = await signedIn(`link-${Date.now()}@gmail.test`, "/files/my");
  const bytes = randomBytes(300_000);
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.getByRole("row", { name: /brief\.pdf/ }).waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Actions for brief.pdf" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "General access" }).click();
  await page.getByRole("option", { name: "Anyone with the link" }).click();
  const link = await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  expect(new URL(link).pathname).toMatch(/^\/s\/[\w-]{22}$/);

  const signedOut = await browser.newContext({ acceptDownloads: true });
  try {
    const anonymous = await signedOut.newPage();
    await anonymous.goto(link);
    const signInLink = anonymous.getByRole("link", { name: "Sign in" });
    expect(await signInLink.getAttribute("href")).toBe(
      `/login?redirect=${encodeURIComponent(new URL(link).pathname)}`,
    );
    const [download] = await Promise.all([
      anonymous.waitForEvent("download"),
      anonymous.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("brief.pdf");
    const saved = await readFile(await download.path());
    expect(sha256(saved)).toBe(sha256(bytes));
  } finally {
    await signedOut.close();
  }
});

test("an XLSX opens to its visible sheets' cells as the workbook shows them", async () => {
  const page = await signedIn(`xlsx-${Date.now()}@gmail.test`, "/files/my");
  const book = utils.book_new();
  const pipeline = utils.aoa_to_sheet([
    ["Region", "Revenue"],
    ["North", 12000.5],
  ]);
  if (pipeline.B2) pipeline.B2.z = '"$"#,##0.00';
  utils.book_append_sheet(book, pipeline, "Pipeline");
  const accounts: WorkSheet = {
    "!ref": "B2:B3",
    B2: { t: "s", v: "Owner" },
    B3: { t: "s", v: "Ana" },
  };
  utils.book_append_sheet(book, accounts, "Accounts");
  utils.book_append_sheet(book, utils.aoa_to_sheet([["kept out of sight"]]), "Hidden");
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] };
  const buffer = write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page.locator("input[type=file]").first().setInputFiles({
    name: "pipeline.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
  await page.getByRole("row", { name: /pipeline\.xlsx/ }).click();

  await page.getByRole("gridcell", { name: "$12,000.50" }).waitFor({ timeout: 15_000 });
  expect(await page.getByRole("tab").allInnerTexts()).toEqual(["Pipeline", "Accounts"]);
  await page.getByRole("tab", { name: "Accounts" }).click();
  const ana = page.getByRole("gridcell", { name: "Ana" });
  await ana.waitFor({ timeout: 5000 });
  expect(await ana.getAttribute("aria-colindex")).toBe("3");
  expect(await ana.locator("..").getAttribute("aria-rowindex")).toBe("4");
});

test("switching workspace mid-upload stops the queue and leaves nothing in either workspace", async () => {
  const email = `switch-${Date.now()}@acme-files.test`;
  const acme = await createOrgWithOwner(db, {
    name: "Acme Files",
    slug: `acme-files-${Date.now()}`,
    ownerEmail: email,
  });
  await db.insert(schema.orgSetup).values({ orgId: acme.orgId, step: "complete" });
  const page = await signedIn(email, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/storage/uploads/*/parts/1", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const names = ["one.bin", "two.bin", "three.bin"];
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(
      names.map((name) => ({
        name,
        mimeType: "application/octet-stream",
        buffer: randomBytes(4096),
      })),
    );
  await page.waitForRequest("**/api/storage/uploads/*/parts/1");

  await page.getByRole("button", { name: /^Switch workspace/ }).click();
  await page.getByRole("menuitem", { name: "Workspace settings" }).click();
  const settingsNav = page.locator('[data-slot="sidebar"]');
  await settingsNav
    .getByRole("button", { name: /^Switch workspace, currently Acme Files/ })
    .click();
  await page.getByRole("menuitem", { name: /(?:'s|^Personal) Workspace$/ }).click();
  await settingsNav
    .getByRole("button", { name: /^Switch workspace, currently .*Workspace$/ })
    .waitFor({ timeout: 15_000 });
  release();
  await page.waitForTimeout(1500);

  const files = await db
    .select({ name: schema.storageNodes.name, orgId: schema.storageNodes.orgId })
    .from(schema.storageNodes)
    .where(inArray(schema.storageNodes.name, names));
  expect(files).toEqual([]);
  const open = await db
    .select({ name: schema.storageUploads.name })
    .from(schema.storageUploads)
    .where(and(eq(schema.storageUploads.orgId, acme.orgId), isNull(schema.storageUploads.nodeId)));
  expect(open).toEqual([]);
});

test("New folder is named in place, and each name creates one folder", async () => {
  const page = await signedIn(`folders-${Date.now()}@gmail.test`, "/files/my");
  const newFolder = {
    click: async () => {
      await page.getByRole("button", { name: "New", exact: true }).first().click();
      await page.getByRole("menuitem", { name: "New folder" }).click();
    },
  };
  await page.getByRole("button", { name: "New", exact: true }).first().waitFor({ timeout: 15_000 });
  const field = page.getByRole("textbox", { name: "Folder name" });

  await newFolder.click();
  await field.waitFor();
  await page.keyboard.type("not kept");
  await page.keyboard.press("Escape");
  await page.getByRole("row", { name: "Untitled folder" }).waitFor();

  await page.getByRole("radio", { name: "Rows" }).first().click();
  await newFolder.click();
  await page.keyboard.type("Plns");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("a");
  await page.keyboard.press("Home");
  await page.keyboard.type("Q3 ");
  await page.keyboard.press("End");
  await page.keyboard.type(" final");
  await page.keyboard.press("Enter");
  await page.getByRole("row", { name: "Q3 Plans final" }).waitFor();
  await page.waitForTimeout(1000);

  const folders = await db
    .select({ name: schema.storageNodes.name })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.kind, "folder"));
  expect(folders.map((f) => f.name).toSorted()).toEqual(["Q3 Plans final", "Untitled folder"]);
  expect(await field.count()).toBe(0);
});

test("Rename changes a name in place on a row and a card, once", async () => {
  const page = await signedIn(`rename-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await page.getByRole("row", { name: /notes\.txt/ }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.keyboard.press("Enter");
  await page.getByRole("row", { name: /Untitled folder/ }).waitFor();
  const renames: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH") renames.push(request.postData() ?? "");
  });
  const field = page.getByRole("textbox", { name: "Name" });

  await page.getByRole("button", { name: "Actions for notes.txt" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await field.waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.type("minutes");
  await page.keyboard.press("Enter");
  await page.getByRole("row", { name: /minutes\.txt/ }).waitFor();

  await page.getByRole("button", { name: "Actions for Untitled folder" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await field.waitFor();
  await page.keyboard.type("Never");
  await page.keyboard.press("Escape");
  expect(await field.count()).toBe(0);
  await page.waitForTimeout(1000);

  expect(renames).toEqual([JSON.stringify({ name: "minutes.txt" })]);
  const files = await db
    .select({ name: schema.storageNodes.name })
    .from(schema.storageNodes)
    .where(inArray(schema.storageNodes.name, ["notes.txt", "minutes.txt"]));
  expect(files).toEqual([{ name: "minutes.txt" }]);
});

test("a Markdown file is edited as a page, saves itself as Markdown, and a newer save is never overwritten unasked", async () => {
  const page = await signedIn(`edit-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      {
        name: "plan.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Plan\n\n- First point\n"),
      },
      { name: "zz.txt", mimeType: "text/plain", buffer: Buffer.from("next") },
    ]);
  await page.getByRole("row", { name: /plan\.md/ }).click();
  const editor = page.locator("[contenteditable=true]");
  await editor.getByRole("heading", { name: "Plan" }).waitFor({ timeout: 15_000 });
  const [file] = await db
    .select({ id: schema.storageNodes.id })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "plan.md"));
  const id = file?.id ?? "";
  const content = () =>
    page.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`);

  const caretAtEndOf = async (text: string) => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const dom = document.querySelector(".ProseMirror") as
            | (Element & {
                editor?: {
                  state: { selection: { $from: { parent: Node; parentOffset: number } } };
                };
              })
            | null;
          const at = dom?.editor?.state.selection.$from;
          return at && `${at.parent.textContent}|${at.parentOffset}`;
        }),
      )
      .toBe(`${text}|${text.length}`);
  };

  await editor.getByText("First point").click();
  await page.keyboard.press("End");
  await caretAtEndOf("First point");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second **point**");
  expect(await page.getByRole("button", { name: "Save" }).count()).toBe(0);
  await expect
    .poll(content, { timeout: 15_000 })
    .toMatch(/^# Plan\n\n- First point\n- Second \*\*point\*\*\n*$/);

  const theirs = await page.evaluate(async (fileId) => {
    const text = "# Theirs\n";
    const opened = await fetch(`/api/storage/files/${fileId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: text.length, mimeType: "text/markdown" }),
    });
    const { upload } = (await opened.json()) as { upload: { id: string } };
    await fetch(`/api/storage/uploads/${upload.id}/parts/1`, { method: "PUT", body: text });
    return (await fetch(`/api/storage/uploads/${upload.id}/complete`, { method: "POST" })).status;
  }, id);
  expect(theirs).toBe(200);

  await editor.getByText("Second").click();
  await page.keyboard.press("End");
  await caretAtEndOf("Second point");
  await page.keyboard.type(" mine");
  const conflict = page.getByRole("alertdialog", { name: "Someone saved a newer version" });
  await conflict.waitFor({ timeout: 15_000 });
  expect(await content()).toBe("# Theirs\n");
  await conflict.getByRole("button", { name: "Keep mine" }).click();
  await expect.poll(content, { timeout: 15_000 }).toContain("- Second **point** mine");

  await editor.getByText("mine").click();
  await page.keyboard.press("End");
  await caretAtEndOf("Second point mine");
  await page.keyboard.type(" again");
  const leaving = page.getByRole("alertdialog", { name: "Save your changes?" });
  for (const key of ["ArrowRight", "ArrowLeft", "Escape"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    expect(await leaving.count()).toBe(0);
  }
  await editor.getByText("mine again").waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(content, { timeout: 15_000 }).toContain("- Second **point** mine again");
  expect(await leaving.count()).toBe(0);
  await expect.poll(() => editor.count()).toBe(0);
});

test("a Markdown file the page cannot keep whole edits as text, and saves every line", async () => {
  const page = await signedIn(`edit-table-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  const text =
    "# Prices\n\n| Plan | Price |\n| --- | --- |\n| Pro | 9 |\n\n<details><summary>Terms</summary>Billed yearly</details>\n";
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "prices.md", mimeType: "text/markdown", buffer: Buffer.from(text) });
  await page.getByRole("row", { name: /prices\.md/ }).click();
  const source = page.locator(".cm-content");
  await source.getByText("| Pro | 9 |").waitFor({ timeout: 15_000 });
  expect(await page.locator(".ProseMirror").count()).toBe(0);
  await source.getByText("| Pro | 9 |").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (monthly)");
  const [file] = await db
    .select({ id: schema.storageNodes.id })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "prices.md"));
  await expect
    .poll(
      () =>
        page.evaluate(
          async (at) => (await fetch(at)).text(),
          `/api/storage/files/${file?.id ?? ""}/content`,
        ),
      { timeout: 15_000 },
    )
    .toBe(text.replace("| Pro | 9 |", "| Pro | 9 | (monthly)"));
});

async function signedIn(email: string, path: string) {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  await context?.close();
  context = await browser.newContext({ acceptDownloads: true });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(path, origin).toString());
  return page;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  }) satisfies Promise<number>;
}

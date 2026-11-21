import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  signInWithPersonalSpace,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

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

test("a box drawn on a PDF page is saved as that page's fractions and pinned there after a reload", async () => {
  const page = await signedIn(`preview-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "deck.pdf", mimeType: "application/pdf", buffer: twoPagePdf() });
  await page.getByRole("row", { name: /deck\.pdf/ }).click({ timeout: 30_000 });

  const second = page.getByLabel("Page 2", { exact: true });
  await second.locator("canvas").first().waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await second.scrollIntoViewIfNeeded();
  const box = await second.boundingBox();
  if (!box) throw new Error("page 2 has no box");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();

  const field = page.getByRole("textbox", { name: "Comment" });
  const bar = await field.boundingBox();
  if (!bar) throw new Error("no comment bar");
  expect(bar.y + bar.height).toBeLessThan(box.y + box.height * 0.3);
  expect(bar.y).toBeGreaterThan(box.y);
  expect(bar.x).toBeGreaterThan(box.x + box.width * 0.25);
  await field.fill("Move this chart up");
  await page.getByRole("button", { name: "Send" }).click();
  await field.waitFor({ state: "hidden" });

  const [row] = await db.select().from(schema.storageComments);
  expect(row?.body).toBe("Move this chart up");
  const anchor = row?.anchor as {
    kind: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expect(anchor.kind).toBe("pdf");
  expect(anchor.page).toBe(2);
  expect(anchor.x).toBeCloseTo(0.25, 2);
  expect(anchor.y).toBeCloseTo(0.3, 2);
  expect(anchor.width).toBeCloseTo(0.25, 2);
  expect(anchor.height).toBeCloseTo(0.2, 2);

  await page.reload();
  const pin = page.getByLabel("Page 2", { exact: true }).getByTestId("comment-pin");
  await pin.waitFor({ timeout: 20_000 });
  const drawn = await pin.boundingBox();
  const again = await page.getByLabel("Page 2", { exact: true }).boundingBox();
  if (!drawn || !again) throw new Error("the pin was not drawn again");
  expect((drawn.x - again.x) / again.width).toBeCloseTo(0.5, 1);
  expect((drawn.y + drawn.height - again.y) / again.height).toBeCloseTo(0.3, 1);
});

function twoPagePdf() {
  const text = "BT /F1 24 Tf 72 700 Td (Quarterly plan) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function signedIn(email: string, path: string) {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace({ url: new URL(origin) }, db, email);
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

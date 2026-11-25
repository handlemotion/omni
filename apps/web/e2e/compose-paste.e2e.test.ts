import { createOrgWithOwner, schema } from "@omni/db";
import { uploadContentId } from "@omni/mail-core/compose";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SHOT_PATH = "/Users/ana/Library/Application Support/CleanShot/media/CleanShot 2026-11-25.png";

function paste(page: Page, files: { name: string; type: string }[], text: string, html = "") {
  return page.getByRole("textbox", { name: "Reply" }).evaluate(
    (el, clip) => {
      const data = new DataTransfer();
      for (const f of clip.files) {
        const bytes = Uint8Array.from(atob(clip.png), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], f.name, { type: f.type }));
      }
      data.setData("text/plain", clip.text);
      if (clip.html) data.setData("text/html", clip.html);
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { files, text, html, png: PNG },
  );
}

async function openReply(email: string, slug: string) {
  const system = await createOrg(db, `${slug}-system`);
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, { name: "Acme", slug, ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const { threadId } = await seedMessage(db, box, {
    subject: "Sidebar question",
    fromAddress: "putri@luna.test",
    uid: 1,
    text: "How do you collapse the sidebar?",
  });
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/inbox/${threadId}`, origin).toString());
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  const body = page.getByRole("textbox", { name: "Reply" });
  await expect.poll(() => body.isEditable(), { timeout: 10_000 }).toBe(true);
  return { page, body, context, mailboxId: box.id, threadId };
}

const sentPayload = async (mailboxId: string) => {
  const actions = await db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, mailboxId));
  return actions.find((a) => a.kind === "send")?.payload as
    | { text?: string; html?: string; attachments?: { kind: string; uploadId?: string }[] }
    | undefined;
};

test("a pasted screenshot shows in the body and goes out inline by cid, not as its file path", async () => {
  const { page, body, context, mailboxId } = await openReply("ana@paste.test", "paste");
  await body.click();
  await page.keyboard.type("See the screenshot.");

  await paste(page, [{ name: "image.png", type: "image/png" }], SHOT_PATH);
  await page.keyboard.type("Thanks!");

  await expect.poll(() => body.locator("img").count()).toBe(1);
  expect(await body.innerText()).toContain("Thanks!");
  expect(await body.innerText()).not.toContain("CleanShot");
  expect(await page.getByRole("list", { name: "Attachments" }).count()).toBe(0);
  await expect.poll(() => page.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);

  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => sentPayload(mailboxId), { timeout: 10_000 }).toBeTruthy();
  const payload = await sentPayload(mailboxId);
  expect(payload?.attachments).toHaveLength(1);
  const uploadId = payload?.attachments?.[0]?.uploadId ?? "";
  expect(payload?.html).toContain(`src="cid:${uploadContentId(uploadId)}"`);
  expect(payload?.html).not.toContain("blob:");
  expect(payload?.text).toMatch(/See the screenshot\.\n\[image: Image .+\.png\]\nThanks!/);
  expect(payload?.text).not.toContain("CleanShot");
  const [upload] = await db.select().from(schema.uploads).where(eq(schema.uploads.id, uploadId));
  expect(upload?.mimeType).toBe("image/png");
  await context.close();
});

test("a draft with a pasted image comes back with the image showing", async () => {
  const { page, body, context, threadId } = await openReply("eve@paste.test", "paste-draft");
  await body.click();
  await page.keyboard.type("Before the picture.");
  await paste(page, [{ name: "image.png", type: "image/png" }], "");
  const saved = async () =>
    (await db.select().from(schema.drafts).where(eq(schema.drafts.threadId, threadId)))[0];
  await expect
    .poll(async () => (await saved())?.bodyHtml ?? "", { timeout: 10_000 })
    .toContain("cid:");
  const draft = await saved();
  const uploadId = (draft?.attachments[0] as { uploadId?: string } | undefined)?.uploadId ?? "";
  expect(draft?.bodyHtml).toContain(`cid:${uploadContentId(uploadId)}`);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("row").filter({ hasText: "Sidebar question" }).click();
  const img = body.locator("img");
  await expect.poll(() => img.getAttribute("src")).toBe(`/api/uploads/${uploadId}`);
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await body.innerText()).toContain("Before the picture.");
  await context.close();
});

test("an image pasted and then deleted from the body is not sent", async () => {
  const { page, body, context, mailboxId } = await openReply("cai@paste.test", "paste-delete");
  await body.click();
  await page.keyboard.type("Never mind.");
  await paste(page, [{ name: "image.png", type: "image/png" }], "");
  await expect.poll(() => body.locator("img").count()).toBe(1);
  await expect.poll(() => page.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);

  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect.poll(() => body.locator("img").count()).toBe(0);

  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => sentPayload(mailboxId), { timeout: 10_000 }).toBeTruthy();
  const payload = await sentPayload(mailboxId);
  expect(payload?.attachments ?? []).toHaveLength(0);
  expect(payload?.html).not.toContain("<img");
  await context.close();
});

test("a pasted PDF is attached as a file, not shown in the body", async () => {
  const { page, body, context, mailboxId } = await openReply("dan@paste.test", "paste-pdf");
  await body.click();
  await page.keyboard.type("The contract.");
  await paste(page, [{ name: "contract.pdf", type: "application/pdf" }], "/Users/dan/contract.pdf");

  const chips = page.getByRole("list", { name: "Attachments" }).getByRole("listitem");
  await expect.poll(() => chips.count()).toBe(1);
  expect(await body.locator("img").count()).toBe(0);
  expect(await body.innerText()).not.toContain("/Users/dan");
  await expect.poll(() => page.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => sentPayload(mailboxId), { timeout: 10_000 }).toBeTruthy();
  expect((await sentPayload(mailboxId))?.attachments).toHaveLength(1);
  await context.close();
});

test("text copied from Word or Excel pastes as text, not as the picture beside it", async () => {
  const { page, body, context } = await openReply("bea@paste.test", "paste-text");
  await body.click();

  await paste(
    page,
    [{ name: "image.png", type: "image/png" }],
    "Q3 totals",
    "<html><body><table><tr><td>Q3 totals</td></tr></table></body></html>",
  );

  await expect.poll(() => body.innerText()).toContain("Q3 totals");
  expect(await body.locator("img").count()).toBe(0);
  expect(await page.getByRole("list", { name: "Attachments" }).count()).toBe(0);
  await context.close();
});

import { createOrgWithOwner, schema } from "@omni/db";
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
  return { page, body, context, mailboxId: box.id };
}

test("a pasted screenshot is attached and sent, not pasted as its file path", async () => {
  const { page, body, context, mailboxId } = await openReply("ana@paste.test", "paste");
  await body.fill("See the screenshot.");

  await paste(page, [{ name: "image.png", type: "image/png" }], SHOT_PATH);

  const chips = page.getByRole("list", { name: "Attachments" }).getByRole("listitem");
  await expect.poll(() => chips.count()).toBe(1);
  await expect.poll(() => chips.first().innerText()).toMatch(/^Image .+\.png/);
  expect(await body.inputValue()).not.toContain("CleanShot");
  await expect.poll(() => page.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);

  await page.getByRole("button", { name: "Send" }).click();
  await body.waitFor({ state: "detached" }).catch(() => body.waitFor({ state: "hidden" }));
  const sent = async () => {
    const actions = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.mailboxId, mailboxId));
    return actions.find((a) => a.kind === "send")?.payload as
      | { text?: string; attachments?: { kind: string; uploadId?: string }[] }
      | undefined;
  };
  await expect.poll(sent, { timeout: 10_000 }).toBeTruthy();
  const payload = await sent();
  expect(payload?.text).not.toContain("CleanShot");
  expect(payload?.attachments).toHaveLength(1);
  const [upload] = await db
    .select()
    .from(schema.uploads)
    .where(eq(schema.uploads.id, payload?.attachments?.[0]?.uploadId ?? ""));
  expect(upload?.mimeType).toBe("image/png");
  expect(upload?.filename).toMatch(/^Image .+\.png$/);
  await context.close();
});

test("text copied from Word or Excel pastes as text, not as the picture beside it", async () => {
  const { page, body, context } = await openReply("bea@paste.test", "paste-text");
  await body.fill("");

  await paste(
    page,
    [{ name: "image.png", type: "image/png" }],
    "Q3 totals",
    "<html><body><table><tr><td>Q3 totals</td></tr></table></body></html>",
  );

  await page.waitForTimeout(300);
  expect(await page.getByRole("list", { name: "Attachments" }).count()).toBe(0);
  await context.close();
});

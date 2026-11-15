// A verification email's Copy code button in a real Chromium, on the web app served by the real
// Worker and a real Postgres: the code reaches the clipboard, and Reply stays within reach.
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser } from "playwright-core";
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

// Catches: a code mail that copies nothing (or the wrong text), one that loses Reply and Forward
// behind the new button, and ordinary mail losing its Reply button to the code check.
test("a verification email offers Copy code, with Reply and Forward under Respond", async () => {
  const email = "ana@codes.test";
  const system = await createOrg(db, "codes-system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "codes", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const code = await seedMessage(db, box, {
    subject: "Verification code",
    fromAddress: "no-reply@signin.test",
    uid: 1,
    text: [
      "Enter the following verification code when prompted:",
      "",
      "654705",
      "",
      "To protect your account, do not share this code.",
      "This code was requested from Mexico City, Mexico at 14 November 2026, 23:14 CST.",
      "© 2026 Terms",
    ].join("\n"),
  });
  const plain = await seedMessage(db, box, {
    subject: "Lunch on Friday?",
    fromAddress: "luis@friends.test",
    uid: 2,
    text: "Are you free at 1300? I booked table 4521.",
  });

  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();

  await page.goto(new URL(`/inbox/${code.threadId}`, origin).toString());
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect.poll(() => page.evaluate("navigator.clipboard.readText()")).toBe("654705");

  await page.getByRole("button", { name: "Respond" }).click();
  await page.getByRole("menuitem", { name: "Forward" }).waitFor();
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await page.getByRole("button", { name: "Send" }).waitFor();

  await page.goto(new URL(`/inbox/${plain.threadId}`, origin).toString());
  // The floating button, by its visible label: the header's icon buttons carry none.
  await page
    .getByRole("button", { name: "Reply", exact: true })
    .filter({ hasText: "Reply" })
    .waitFor();
  expect(await page.getByRole("button", { name: "Copy code" }).count()).toBe(0);
  await context.close();
});

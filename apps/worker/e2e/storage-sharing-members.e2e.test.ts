import { randomBytes, randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { CookieJar, sentMail, signIn, startWorker, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_STORAGE_LINK: "off" },
  });
});
afterAll(() => stack?.stop());

const linkOf = async (jar: CookieJar, nodeId: string) => {
  const set = await stack.api(jar, "PUT", `/nodes/${nodeId}/sharing/link`, {
    linkAccess: "restricted",
  });
  if (set.status !== 200) throw new Error(`link: ${set.status}`);
  return set.body.sharing.shareId as string;
};

test("a Restricted link opens for a teammate who reaches the item as a member, and for nobody else", async () => {
  const org = await stack.company(`team-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "member");
  const bo = await stack.member(org.id, "member");
  const admin = await stack.member(org.id, "admin");
  const elsewhere = await stack.company(`else-${randomUUID().slice(0, 8)}`);
  const outsider = await stack.member(elsewhere.id, "owner");

  const made = await stack.api(ana.jar, "POST", "/folders", { name: "Plans", space: "shared" });
  const plans = made.body.node.id as string;
  const bytes = randomBytes(2500);
  const roadmap = await stack.upload(ana.jar, { parentId: plans }, "roadmap.pdf", bytes);
  const diary = await stack.upload(ana.jar, { space: "personal" }, "diary.txt", randomBytes(20));
  const plansLink = await linkOf(ana.jar, plans);
  const diaryLink = await linkOf(ana.jar, diary.id);
  const file = (jar: CookieJar, shareId: string, nodeId: string) =>
    stack.get(jar, `/shared/${shareId}/files/${nodeId}/content`);

  const opened = await stack.api(bo.jar, "GET", `/shared/${plansLink}`);
  expect(opened).toMatchObject({
    status: 200,
    body: { item: { node: { id: plans }, role: "member" }, nodes: [{ name: "roadmap.pdf" }] },
  });
  const got = await file(bo.jar, plansLink, roadmap.id);
  expect(got.status).toBe(200);
  expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);
  const added = await stack.api(bo.jar, "POST", `/shared/${plansLink}/folders`, {
    name: "From Bo",
    parentId: plans,
  });
  expect(added).toMatchObject({ status: 201, body: { node: { space: "shared", orgId: org.id } } });
  expect((await file(ana.jar, diaryLink, diary.id)).status).toBe(200);

  for (const jar of [outsider.jar, new CookieJar()]) {
    expect((await stack.api(jar, "GET", `/shared/${plansLink}`)).status).toBe(404);
    expect((await file(jar, plansLink, roadmap.id)).status).toBe(404);
  }
  for (const jar of [admin.jar, bo.jar]) {
    expect((await stack.api(jar, "GET", `/shared/${diaryLink}`)).status).toBe(404);
    expect((await file(jar, diaryLink, diary.id)).status).toBe(404);
    expect((await file(jar, plansLink, diary.id)).status).toBe(404);
  }
});

test("with no SYSTEM_MAIL_FROM a person is added without a mail and finds the item under Shared with me", async () => {
  const org = await stack.company(`quiet-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const made = await stack.api(ana.jar, "POST", "/folders", { name: "Quiet", space: "personal" });
  const guestEmail = `guest-${randomUUID().slice(0, 8)}@outside.test`;

  const quiet = await startWorker({
    databaseUrl: stack.database.url,
    mailServiceUrl: "http://127.0.0.1:9",
    vars: { SYSTEM_MAIL_FROM: "", WEB_APP_URL: WEB_ORIGIN },
  });
  try {
    const put = await fetch(
      new URL(
        `/api/storage/nodes/${made.body.node.id}/sharing/people/${encodeURIComponent(guestEmail)}`,
        quiet.url,
      ),
      {
        method: "PUT",
        headers: { cookie: ana.jar.header, "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      sharing: { people: [{ email: guestEmail, role: "viewer" }] },
    });
    expect(await sentMail(quiet, guestEmail)).toEqual([]);
  } finally {
    await quiet.server.close();
  }
  expect(
    await stack.db
      .select({ role: schema.storageGrants.role })
      .from(schema.storageGrants)
      .where(eq(schema.storageGrants.email, guestEmail)),
  ).toEqual([{ role: "viewer" }]);

  const guest = new CookieJar();
  await signIn(stack.worker, stack.db, guestEmail, guest);
  expect((await stack.api(guest, "GET", "/shared-with-me")).body.items).toMatchObject([
    { node: { name: "Quiet" }, role: "viewer" },
  ]);
});

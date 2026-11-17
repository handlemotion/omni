import { listServiceMailboxes, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { greenmail, type OnboardingStack, startOnboardingStack } from "./onboarding-stack.ts";
import { authPost, CookieJar, createMember, signIn, WEB_ORIGIN } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);
const tag = () => crypto.randomUUID().slice(0, 8);

function placement(domainId: string, localPart: string) {
  return {
    domainId,
    localPart,
    login: {
      password: "app-password",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  };
}

async function teammate(orgId: string, role: "admin" | "member") {
  const { db } = stack.database;
  const email = `${role}-${tag()}@elsewhere.test`;
  const member = await createMember(db, orgId, email);
  await db.update(schema.members).set({ role }).where(eq(schema.members.id, member.id));
  const jar = new CookieJar();
  await signIn(stack.worker, db, email, jar);
  return { ...member, email, jar };
}

const visibleIds = async (jar: CookieJar) =>
  ((await api(jar, "GET", "/mailboxes")).body.mailboxes as { id: string }[]).map((m) => m.id);
const syncing = async () => (await listServiceMailboxes(stack.database.db)).map((m) => m.id);
async function grantsOn(mailboxId: string) {
  const rows = await stack.database.db
    .select({ memberId: schema.mailboxAccess.memberId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows.map((row) => row.memberId).toSorted();
}

async function benLeft() {
  const owner = await stack.workspaceWithDomain();
  const ben = await teammate(owner.orgId, "member");
  const issued = await api(
    owner.jar,
    "POST",
    `/workspace/members/${ben.id}/inboxes`,
    placement(owner.domainId, `ben${tag()}`),
  );
  expect(issued.status).toBe(200);
  const inboxId = issued.body.mailboxId as string;
  expect(await syncing()).toContain(inboxId);
  const removed = await authPost(stack.worker, owner.jar, "/organization/remove-member", {
    memberIdOrEmail: ben.email,
  });
  expect(removed.status).toBe(200);
  return { owner, ben, inboxId, address: issued.body.address as string };
}

test("a departed member's inbox is orphaned, stops syncing, and can be given to someone", async () => {
  const { owner, inboxId, address } = await benLeft();
  const cy = await teammate(owner.orgId, "member");
  const dee = await teammate(owner.orgId, "member");

  const listed = await api(owner.jar, "GET", "/workspace/inboxes");
  expect(listed.body.inboxes).toMatchObject([{ id: inboxId, owner: null, orphaned: true }]);
  expect(await syncing()).not.toContain(inboxId);
  expect(await visibleIds(owner.jar)).not.toContain(inboxId);

  const give = (memberId: string) =>
    api(owner.jar, "POST", `/workspace/inboxes/${inboxId}/owner`, { memberId });
  const self = await api(cy.jar, "POST", `/workspace/inboxes/${inboxId}/owner`, {
    memberId: cy.id,
  });
  expect(self.status).toBe(403);

  expect((await give(cy.id)).status).toBe(200);
  expect(await grantsOn(inboxId)).toEqual([cy.id]);
  expect(await visibleIds(cy.jar)).toContain(inboxId);
  expect(await visibleIds(owner.jar)).not.toContain(inboxId);
  expect(await syncing()).toContain(inboxId);
  expect((await give(cy.id)).status).toBe(200);
  expect((await give(dee.id)).status).toBe(409);
  expect(await grantsOn(inboxId)).toEqual([cy.id]);
  const share = await api(owner.jar, "POST", `/workspace/inboxes/${inboxId}/shared`, {
    memberIds: [dee.id],
  });
  expect(share.status).toBe(409);

  const events = await api(owner.jar, "GET", "/workspace/events");
  expect(events.body.events).toMatchObject([
    { action: "inbox.given", address, data: { mailboxId: inboxId, memberIds: [cy.id] } },
    { action: "inbox.given", address },
    { action: "inbox.issued", address },
  ]);
  expect((await api(cy.jar, "GET", "/workspace/events")).status).toBe(403);
});

test("a departed member's inbox can become a shared inbox for the people named", async () => {
  const { owner, inboxId } = await benLeft();
  const cy = await teammate(owner.orgId, "member");
  const dee = await teammate(owner.orgId, "admin");

  const share = () =>
    api(owner.jar, "POST", `/workspace/inboxes/${inboxId}/shared`, { memberIds: [cy.id, dee.id] });
  expect((await share()).status).toBe(200);
  expect((await share()).status).toBe(200);
  expect(await grantsOn(inboxId)).toEqual([cy.id, dee.id].toSorted());
  const people = await api(owner.jar, "GET", `/workspace/shared-inboxes/${inboxId}/people`);
  expect((people.body.people as { memberId: string }[]).map((p) => p.memberId).toSorted()).toEqual(
    [cy.id, dee.id].toSorted(),
  );
  expect(await syncing()).toContain(inboxId);
  const give = await api(owner.jar, "POST", `/workspace/inboxes/${inboxId}/owner`, {
    memberId: cy.id,
  });
  expect(give.status).toBe(404);
});

test("any inbox can be removed, but not someone's only one", async () => {
  const { db } = stack.database;
  const owner = await stack.workspaceWithDomain();
  const ana = await teammate(owner.orgId, "member");
  const issued = await api(
    owner.jar,
    "POST",
    `/workspace/members/${ana.id}/inboxes`,
    placement(owner.domainId, `ana${tag()}`),
  );
  const anas = issued.body.mailboxId as string;
  const remove = async (jar: CookieJar, id: string) =>
    (
      await fetch(new URL(`/api/workspace/inboxes/${id}`, stack.worker.url), {
        method: "DELETE",
        headers: { cookie: jar.header, origin: WEB_ORIGIN },
      })
    ).status;

  expect(await remove(ana.jar, anas)).toBe(403);
  expect(await remove(owner.jar, anas)).toBe(409);

  const second = await api(
    owner.jar,
    "POST",
    `/workspace/members/${ana.id}/inboxes`,
    placement(owner.domainId, `ana2${tag()}`),
  );
  expect(second.status).toBe(200);
  expect(await remove(owner.jar, anas)).toBe(204);
  expect(
    await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, anas)),
  ).toHaveLength(0);
  expect(await remove(owner.jar, anas)).toBe(204);
  const events = await api(owner.jar, "GET", "/workspace/events");
  expect((events.body.events as { action: string }[])[0]).toMatchObject({
    action: "inbox.removed",
  });
});

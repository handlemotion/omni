// The workspace admin surface for inboxes (ADR 0026), on the onboarding stack: real Worker, real
// mail service, GreenMail and Postgres. Owners and admins see who can open what and hand out
// inboxes; nobody reads anyone's mail through it, and nobody is left with no inbox.
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { greenmail, type OnboardingStack, startOnboardingStack } from "./onboarding-stack.ts";
import { CookieJar, createMember, seedMessage, signIn } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);

/** An existing login on the mail host (GreenMail takes any password). */
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

async function teammate(orgId: string, email: string, role: "admin" | "member") {
  const { db } = stack.database;
  const member = await createMember(db, orgId, email);
  await db.update(schema.members).set({ role }).where(eq(schema.members.id, member.id));
  const jar = new CookieJar();
  await signIn(stack.worker, db, email, jar);
  return { ...member, jar };
}

async function grantsOn(mailboxId: string) {
  const rows = await stack.database.db
    .select({ memberId: schema.mailboxAccess.memberId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows.map((row) => row.memberId).toSorted();
}

type Row = {
  id: string;
  inboxes: { id: string; address: string }[];
  sharedInboxes: { id: string }[];
  inboxCount: number;
};

test("a member can be issued several inboxes; People sees them in one call, and no mail", async () => {
  const { db } = stack.database;
  const owner = await stack.workspaceWithDomain();
  const { orgId, domain, domainId, jar } = owner;
  const ana = await teammate(
    orgId,
    `ana-${crypto.randomUUID().slice(0, 8)}@elsewhere.test`,
    "admin",
  );
  const ben = await teammate(
    orgId,
    `ben-${crypto.randomUUID().slice(0, 8)}@elsewhere.test`,
    "member",
  );

  const first = await api(
    jar,
    "POST",
    `/workspace/members/${ben.id}/inboxes`,
    placement(domainId, "ben"),
  );
  // An admin, not only the owner, issues them.
  const second = await api(
    ana.jar,
    "POST",
    `/workspace/members/${ben.id}/inboxes`,
    placement(domainId, "ben.sales"),
  );
  expect([first.status, second.status]).toEqual([200, 200]);
  // Bug caught: the issuer getting a grant on the inbox they made (they could read it).
  expect(await grantsOn(first.body.mailboxId as string)).toEqual([ben.id]);
  expect(await grantsOn(second.body.mailboxId as string)).toEqual([ben.id]);

  const [row] = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, first.body.mailboxId as string));
  await seedMessage(db, row!, {
    subject: "Ben's private 9c1e",
    fromAddress: "x@example.test",
    uid: 1,
  });

  const listed = await api(jar, "GET", "/workspace/members");
  expect(listed.status).toBe(200);
  const bens = (listed.body.members as Row[]).find((m) => m.id === ben.id);
  // Bug caught: a second inbox missing from the person's row (only the first one shown).
  expect(bens?.inboxes.map((i) => i.address).toSorted()).toEqual([
    `ben.sales@${domain}`,
    `ben@${domain}`,
  ]);
  expect(bens?.inboxCount).toBe(2);
  expect((listed.body.members as Row[]).find((m) => m.id === ana.id)?.inboxCount).toBe(0);
  expect(JSON.stringify(listed.body)).not.toContain("9c1e");

  const one = await api(jar, "GET", `/workspace/members/${ben.id}/inboxes`);
  expect((one.body.inboxes as unknown[]).length).toBe(2);

  // Issuing the same address again is a no-op; for someone else it is refused.
  const again = await api(
    jar,
    "POST",
    `/workspace/members/${ben.id}/inboxes`,
    placement(domainId, "ben"),
  );
  expect(again.body.mailboxId).toBe(first.body.mailboxId);
  const stolen = await api(
    jar,
    "POST",
    `/workspace/members/${ana.id}/inboxes`,
    placement(domainId, "ben"),
  );
  expect(stolen.status).toBe(409);
  expect(await grantsOn(first.body.mailboxId as string)).toEqual([ben.id]);

  // Bug caught: a plain member reaching the admin surface.
  for (const [method, path] of [
    ["GET", "/workspace/members"],
    ["GET", "/workspace/inboxes"],
    ["GET", `/workspace/members/${ben.id}/inboxes`],
  ] as const) {
    expect((await api(ben.jar, method, path)).status).toBe(403);
  }
  const selfIssued = await api(
    ben.jar,
    "POST",
    `/workspace/members/${ben.id}/inboxes`,
    placement(domainId, "ben.extra"),
  );
  expect(selfIssued.status).toBe(403);

  // Bug caught: issuing an inbox to someone from another workspace.
  const other = await stack.workspaceWithDomain();
  const stranger = (await api(other.jar, "GET", "/me")).body.id as string;
  const crossed = await api(
    jar,
    "POST",
    `/workspace/members/${stranger}/inboxes`,
    placement(domainId, "x"),
  );
  expect(crossed.status).toBe(404);
});

test("a shared inbox is seen by exactly the people named, and nobody loses their last inbox", async () => {
  const owner = await stack.workspaceWithDomain();
  const { orgId, domainId, jar } = owner;
  const ana = await teammate(
    orgId,
    `ana-${crypto.randomUUID().slice(0, 8)}@elsewhere.test`,
    "member",
  );
  const ben = await teammate(
    orgId,
    `ben-${crypto.randomUUID().slice(0, 8)}@elsewhere.test`,
    "member",
  );

  const body = { ...placement(domainId, "support"), memberIds: [ana.id, ben.id] };
  const made = await api(jar, "POST", "/workspace/shared-inboxes", body);
  expect(made.status).toBe(200);
  const supportId = made.body.mailboxId as string;
  // Bug caught: the creator seeded onto the team without naming themselves.
  expect(await grantsOn(supportId)).toEqual([ana.id, ben.id].toSorted());
  // A retry adds no one and makes no second mailbox.
  const retried = await api(jar, "POST", "/workspace/shared-inboxes", body);
  expect(retried.body.mailboxId).toBe(supportId);
  const people = await api(jar, "GET", `/workspace/shared-inboxes/${supportId}/people`);
  expect((people.body.people as { memberId: string }[]).map((p) => p.memberId).toSorted()).toEqual(
    [ana.id, ben.id].toSorted(),
  );
  const inboxes = await api(jar, "GET", "/workspace/inboxes");
  expect(inboxes.body.inboxes).toMatchObject([{ id: supportId, kind: "shared", orphaned: false }]);

  // Support is the only inbox Ben can open. Bug caught: leaving a member with nothing to read.
  const removeBen = `/workspace/shared-inboxes/${supportId}/people/${ben.id}`;
  expect((await api(jar, "DELETE", removeBen)).status).toBe(409);
  // The older route keeps the same rule.
  expect((await api(jar, "DELETE", `/mailboxes/${supportId}/members/${ben.id}`)).status).toBe(409);
  expect(await grantsOn(supportId)).toContain(ben.id);

  // With a second inbox, Ben can come off support.
  const hello = await api(jar, "POST", "/workspace/shared-inboxes", {
    ...placement(domainId, "hello"),
    memberIds: [ben.id],
  });
  expect(hello.status).toBe(200);
  expect((await api(jar, "DELETE", removeBen)).status).toBe(200);
  expect(await grantsOn(supportId)).toEqual([ana.id]);
  // Idempotent: removing someone not on it changes nothing (and is not their last inbox).
  expect((await api(jar, "DELETE", removeBen)).status).toBe(200);

  // Bug caught: naming someone from another workspace onto a shared inbox.
  const other = await stack.workspaceWithDomain();
  const stranger = (await api(other.jar, "GET", "/me")).body.id as string;
  const crossed = await api(jar, "POST", "/workspace/shared-inboxes", {
    ...placement(domainId, "crossed"),
    memberIds: [stranger],
  });
  expect(crossed.status).toBe(404);
  // And a plain member creating one.
  const byMember = await api(ana.jar, "POST", "/workspace/shared-inboxes", {
    ...placement(domainId, "mine"),
    memberIds: [ana.id],
  });
  expect(byMember.status).toBe(403);
});

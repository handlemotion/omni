// Inviting someone with their inbox (ADR 0026), on the onboarding stack: real Worker, real mail
// service, GreenMail and Postgres. The inbox is made at invite time and waits with no owner, so
// nobody can open it; accepting the invitation makes it the new member's. An invitation must give
// them an inbox, their own or a shared one.
import { listServiceMailboxes, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { greenmail, type OnboardingStack, startOnboardingStack } from "./onboarding-stack.ts";
import { authPost, CookieJar, createMember, signIn } from "./support.ts";

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

async function grantsOn(mailboxId: string) {
  const rows = await stack.database.db
    .select({ memberId: schema.mailboxAccess.memberId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows.map((row) => row.memberId);
}
const syncing = async () => (await listServiceMailboxes(stack.database.db)).map((m) => m.id);
const visibleIds = async (jar: CookieJar) =>
  ((await api(jar, "GET", "/mailboxes")).body.mailboxes as { id: string }[]).map((m) => m.id);

/** The invitee signs in and accepts; returns their member id here and their jar. */
async function accept(email: string, invitationId: string, orgId: string) {
  const jar = new CookieJar();
  await signIn(stack.worker, stack.database.db, email, jar);
  const accepted = await authPost(stack.worker, jar, "/organization/accept-invitation", {
    invitationId,
  });
  expect(accepted.status).toBe(200);
  const [member] = await stack.database.db
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(and(eq(schema.users.email, email), eq(schema.members.organizationId, orgId)));
  await authPost(stack.worker, jar, "/organization/set-active", { organizationId: orgId });
  return { id: member!.id, jar };
}

test("an inbox made with an invitation waits unowned, and becomes theirs when they accept", async () => {
  const owner = await stack.workspaceWithDomain();
  const email = `new-${tag()}@elsewhere.test`;
  const local = `new${tag()}`;
  const invited = await api(owner.jar, "POST", "/workspace/invitations", {
    email,
    inbox: placement(owner.domainId, local),
  });
  expect(invited.status).toBe(200);
  const inboxId = (invited.body.inbox as { mailboxId: string }).mailboxId;
  const invitationId = (invited.body.invitation as { id: string }).id;

  // Bug caught: the inviter (or anyone) holding a grant on an inbox meant for the invitee.
  expect(await grantsOn(inboxId)).toEqual([]);
  expect(await syncing()).not.toContain(inboxId);
  expect(await visibleIds(owner.jar)).not.toContain(inboxId);
  // Bug caught: the reserved address handed to someone else before the invitee accepts.
  const other = await createMember(stack.database.db, owner.orgId, `other-${tag()}@x.test`);
  const taken = await api(
    owner.jar,
    "POST",
    `/workspace/members/${other.id}/inboxes`,
    placement(owner.domainId, local),
  );
  expect(taken.status).toBe(409);

  const invitee = await accept(email, invitationId, owner.orgId);
  expect(await grantsOn(inboxId)).toEqual([invitee.id]);
  expect(await visibleIds(invitee.jar)).toContain(inboxId);
  expect(await visibleIds(owner.jar)).not.toContain(inboxId);
  expect(await syncing()).toContain(inboxId);

  const events = await api(owner.jar, "GET", "/workspace/events");
  expect(events.body.events).toMatchObject([
    { action: "inbox.given", data: { mailboxId: inboxId, invitationId, memberIds: [invitee.id] } },
    { action: "inbox.issued", data: { mailboxId: inboxId, invitationId } },
  ]);
});

test("an invitation must give an inbox; shared ones are joined on accepting", async () => {
  const owner = await stack.workspaceWithDomain();
  const ana = await createMember(stack.database.db, owner.orgId, `ana-${tag()}@x.test`);
  const support = await api(owner.jar, "POST", "/workspace/shared-inboxes", {
    ...placement(owner.domainId, `support${tag()}`),
    memberIds: [ana.id],
  });
  const supportId = support.body.mailboxId as string;

  // Bug caught: a new member who can open nothing.
  const bare = await api(owner.jar, "POST", "/workspace/invitations", {
    email: `bare-${tag()}@x.test`,
  });
  expect(bare.status).toBe(422);
  // Bug caught: inviting someone onto another workspace's shared inbox.
  const elsewhere = await stack.workspaceWithDomain();
  const crossed = await api(elsewhere.jar, "POST", "/workspace/invitations", {
    email: `crossed-${tag()}@x.test`,
    sharedInboxIds: [supportId],
  });
  expect(crossed.status).toBe(404);

  const email = `bo-${tag()}@elsewhere.test`;
  const invited = await api(owner.jar, "POST", "/workspace/invitations", {
    email,
    sharedInboxIds: [supportId],
  });
  expect(invited.status).toBe(200);
  expect(invited.body.inbox).toBeNull();
  const bo = await accept(email, (invited.body.invitation as { id: string }).id, owner.orgId);
  expect((await grantsOn(supportId)).toSorted()).toEqual([ana.id, bo.id].toSorted());
  expect(await visibleIds(bo.jar)).toContain(supportId);

  // Bug caught: a plain member inviting people.
  const boInvites = await api(bo.jar, "POST", "/workspace/invitations", {
    email: `x-${tag()}@x.test`,
    sharedInboxIds: [supportId],
  });
  expect(boInvites.status).toBe(403);
});

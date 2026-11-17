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

  expect(await grantsOn(inboxId)).toEqual([]);
  expect(await syncing()).not.toContain(inboxId);
  expect(await visibleIds(owner.jar)).not.toContain(inboxId);
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
  const early = await api(owner.jar, "POST", "/workspace/invitations", {
    email: `early-${tag()}@x.test`,
  });
  expect(early.status).toBe(200);
  const ana = await createMember(stack.database.db, owner.orgId, `ana-${tag()}@x.test`);
  const support = await api(owner.jar, "POST", "/workspace/shared-inboxes", {
    ...placement(owner.domainId, `support${tag()}`),
    memberIds: [ana.id],
  });
  const supportId = support.body.mailboxId as string;

  const bare = await api(owner.jar, "POST", "/workspace/invitations", {
    email: `bare-${tag()}@x.test`,
  });
  expect(bare.status).toBe(422);
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

  const direct = await authPost(stack.worker, owner.jar, "/organization/invite-member", {
    email: `direct-${tag()}@x.test`,
    role: "member",
  });
  expect(direct.status).toBe(404);

  const laterEmail = `later-${tag()}@x.test`;
  await api(owner.jar, "POST", "/workspace/invitations", {
    email: laterEmail,
    sharedInboxIds: [supportId],
  });
  const oldResend = await authPost(stack.worker, owner.jar, "/organization/invite-member", {
    email: laterEmail,
    role: "member",
    resend: true,
  });
  expect(oldResend.status).toBe(200);
  const sneaky = await authPost(stack.worker, owner.jar, "/organization/invite-member", {
    email: `sneaky-${tag()}@x.test`,
    role: "member",
    resend: true,
  });
  expect(sneaky.status).toBe(404);

  const pending = await api(owner.jar, "POST", "/workspace/invitations", {
    email: `later-${tag()}@x.test`,
    sharedInboxIds: [supportId],
  });
  const pendingId = (pending.body.invitation as { id: string }).id;
  expect((await api(owner.jar, "POST", `/workspace/invitations/${pendingId}/resend`)).status).toBe(
    200,
  );
  const [resent] = await stack.database.db
    .select({ teamId: schema.invitations.teamId })
    .from(schema.invitations)
    .where(eq(schema.invitations.id, pendingId));
  expect(resent?.teamId).toBeTruthy();

  const boInvites = await api(bo.jar, "POST", "/workspace/invitations", {
    email: `x-${tag()}@x.test`,
    sharedInboxIds: [supportId],
  });
  expect(boInvites.status).toBe(403);
});

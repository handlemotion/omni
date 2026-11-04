// More than one domain per workspace, managed from settings (ADR 0016): adding one after setup
// through the same claim and check as onboarding, the cross-workspace lock, who may add and
// remove, and what removing does. Real Worker, real mail service on GreenMail, the local
// authoritative DNS server, Postgres; nothing mocked.
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  greenmail,
  type OnboardingStack,
  startOnboardingStack,
  waitFor,
} from "./onboarding-stack.ts";
import { CookieJar, createMember, signIn } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);

/** A workspace that finished setup: its domain verified, one mailbox syncing, setup complete. */
async function finishedWorkspace() {
  const workspace = await stack.workspaceWithDomain();
  const created = await api(workspace.jar, "POST", "/onboarding/mailboxes", {
    domainId: workspace.domainId,
    localPart: "hello",
    login: {
      password: "app-password",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  });
  expect(created.status).toBe(200);
  const mailboxId = created.body.mailboxId as string;
  await waitFor(async () => {
    const [row] = await stack.database.db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });
  expect(await api(workspace.jar, "POST", "/onboarding/complete")).toMatchObject({
    status: 200,
    body: { setup: "complete" },
  });
  return { ...workspace, mailboxId };
}

/** Someone else in the workspace with `role`, signed in. */
async function teammate(orgId: string, role: "member" | "admin") {
  const email = `${role}-${randomUUID().slice(0, 8)}@people.test`;
  const member = await createMember(stack.database.db, orgId, email);
  await stack.database.db
    .update(schema.members)
    .set({ role })
    .where(eq(schema.members.id, member.id));
  const jar = new CookieJar();
  await signIn(stack.worker, stack.database.db, email, jar);
  return { ...member, jar };
}

const newDomain = () => {
  const domain = `second-${randomUUID().slice(0, 8)}.test`;
  stack.dns.addZone(domain);
  return domain;
};

// Bug caught: adding a second domain from settings moves `org_setup` back to `domain_added` (the
// claim route advances setup), so a finished workspace is sent back into onboarding; or a second
// claim replaces the first in the list the settings page reads.
test("a finished workspace adds a second domain through the same claim and check, and stays set up", async () => {
  const a = await finishedWorkspace();
  const second = newDomain();
  const added = await api(a.jar, "POST", "/onboarding/domains", { domain: second });
  expect(added).toMatchObject({
    status: 200,
    body: { domain: second, status: "pending", challenge: { value: expect.any(String) } },
  });

  let status = await api(a.jar, "GET", "/onboarding");
  expect(status.body.organization).toMatchObject({ setup: "complete" });
  expect((status.body.domains as { domain: string }[]).map((d) => d.domain)).toEqual([
    a.domain,
    second,
  ]);

  stack.publishChallenge(added.body);
  expect(await api(a.jar, "POST", `/onboarding/domains/${added.body.id}/check`)).toMatchObject({
    status: 200,
    body: { status: "verified", added: true },
  });
  status = await api(a.jar, "GET", "/onboarding");
  expect(status.body.organization).toMatchObject({ setup: "complete" });
  expect(status.body.domains).toEqual([
    expect.objectContaining({ domain: a.domain, status: "verified" }),
    expect.objectContaining({ domain: second, status: "verified" }),
  ]);
  const locks = await stack.database.db
    .select({ domain: schema.mailDomains.domain })
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.orgId, a.orgId));
  expect(locks.map((l) => l.domain).sort()).toEqual([a.domain, second].sort());
});

// Bug caught: a domain (or a subdomain of one) that another workspace verified can be added and
// verified again from settings, so two workspaces create mailboxes on one domain.
test("a domain another workspace verified, or a name under it, cannot be added or verified", async () => {
  const a = await finishedWorkspace();
  const b = await stack.signedInOwner();
  expect(await api(b.jar, "POST", "/onboarding/domains", { domain: a.domain })).toEqual({
    status: 409,
    body: { error: `${a.domain} is already set up by another workspace` },
  });
  expect(await api(b.jar, "POST", "/onboarding/domains", { domain: `mail.${a.domain}` })).toEqual({
    status: 409,
    body: { error: `mail.${a.domain} is under ${a.domain}, which another workspace set up` },
  });
  expect((await api(b.jar, "GET", "/onboarding")).body.domains).toEqual([]);
  const locks = await stack.database.db
    .select({ orgId: schema.mailDomains.orgId })
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.domain, a.domain));
  expect(locks).toEqual([{ orgId: a.orgId }]);
});

// Bug caught: the add or remove routes check only that the caller is in the workspace, so any
// member can claim names for it or release the domain its mail runs on.
test("a plain member can neither add nor remove a domain", async () => {
  const a = await finishedWorkspace();
  const member = await teammate(a.orgId, "member");
  expect(await api(member.jar, "POST", "/onboarding/domains", { domain: newDomain() })).toEqual({
    status: 403,
    body: { error: "only owners and admins can set up mail" },
  });
  expect(await api(member.jar, "POST", `/onboarding/domains/${a.domainId}/release`)).toEqual({
    status: 403,
    body: { error: "only owners and admins can set up mail" },
  });
  const claims = await stack.database.db
    .select({ domain: schema.domainClaims.domain, status: schema.domainClaims.status })
    .from(schema.domainClaims)
    .where(eq(schema.domainClaims.orgId, a.orgId));
  expect(claims).toEqual([{ domain: a.domain, status: "verified" }]);
});

// Bugs caught: a claim that never verified cannot be removed (it sits in the list and the cap
// until it expires); removing a verified domain deletes or orphans its mailboxes; an admin
// releases a domain only owners may give up.
test("removing: an admin withdraws a pending claim, a verified domain stays while it has mailboxes", async () => {
  const { db } = stack.database;
  const a = await finishedWorkspace();
  const admin = await teammate(a.orgId, "admin");

  // A pending claim, withdrawn by an admin: gone from the list, and adding it again starts over.
  const pending = newDomain();
  const claim = await api(admin.jar, "POST", "/onboarding/domains", { domain: pending });
  expect(claim.status).toBe(200);
  expect(await api(admin.jar, "POST", `/onboarding/domains/${claim.body.id}/release`)).toEqual({
    status: 200,
    body: { released: true },
  });
  expect(
    (await api(a.jar, "GET", "/onboarding")).body.domains as { domain: string }[],
  ).not.toContainEqual(expect.objectContaining({ domain: pending }));
  const [withdrawn] = await db
    .select({ status: schema.domainClaims.status })
    .from(schema.domainClaims)
    .where(eq(schema.domainClaims.id, claim.body.id as string));
  expect(withdrawn).toEqual({ status: "released" });
  const events = await db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.orgId, a.orgId), eq(schema.auditEvents.subject, pending)))
    .orderBy(schema.auditEvents.createdAt, schema.auditEvents.id);
  expect(events.map((e) => e.action)).toEqual(["domain.claimed", "domain.claim_withdrawn"]);
  // The old value is void: adding it again makes a new one, and the old one in DNS does not count.
  stack.publishChallenge(claim.body);
  const again = await api(admin.jar, "POST", "/onboarding/domains", { domain: pending });
  expect(again.body).toMatchObject({ status: "pending", challenge: { value: expect.any(String) } });
  expect(again.body.challenge).not.toEqual(claim.body.challenge);
  expect(
    (await api(admin.jar, "POST", `/onboarding/domains/${again.body.id}/check`)).body,
  ).toMatchObject({ status: "pending" });

  // A verified domain: not by an admin, and not by an owner while a mailbox is on it.
  expect(await api(admin.jar, "POST", `/onboarding/domains/${a.domainId}/release`)).toEqual({
    status: 403,
    body: { error: "only owners can release or move a domain" },
  });
  expect(await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/release`)).toEqual({
    status: 409,
    body: { error: `${a.domain} still has mailboxes in this workspace` },
  });
  const [lock] = await db
    .select({ orgId: schema.mailDomains.orgId })
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.domain, a.domain));
  expect(lock).toEqual({ orgId: a.orgId });
  const [mailbox] = await db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, a.mailboxId));
  expect(mailbox).toEqual({ id: a.mailboxId });
});

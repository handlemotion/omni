import { randomUUID } from "node:crypto";
import { claimUsage, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { greenmail, type OnboardingStack, startOnboardingStack } from "./onboarding-stack.ts";
import { BILLING_SECRETS, PLAN_PRICES } from "./stripe-events.ts";
import { authPost, CookieJar, createMailbox, justMe, signIn } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack({ workerVars: PLAN_PRICES, workerSecrets: BILLING_SECRETS });
}, 60_000);
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);
const tag = () => randomUUID().slice(0, 8);

async function subscribe(orgId: string, plan: "team" | "business") {
  const id = randomUUID();
  const now = Date.now();
  await stack.database.db.insert(schema.subscriptions).values({
    id,
    plan,
    orgId,
    status: "active",
    periodStart: new Date(now - 86_400_000),
    periodEnd: new Date(now + 29 * 86_400_000),
    billingInterval: "month",
  });
  return id;
}

async function lapse(subscriptionId: string) {
  await stack.database.db
    .update(schema.subscriptions)
    .set({ status: "canceled", endedAt: new Date() })
    .where(eq(schema.subscriptions.id, subscriptionId));
}

const invite = (jar: Parameters<typeof api>[0]) =>
  api(jar, "POST", "/workspace/invitations", { email: `guest-${tag()}@elsewhere.test` });

async function holdDomains(orgId: string, count: number) {
  await stack.database.db.insert(schema.domainClaims).values(
    Array.from({ length: count }, () => ({
      orgId,
      domain: `held-${tag()}.test`,
      status: "verified" as const,
      challengeHash: "e2e",
      provider: "imap" as const,
      expiresAt: new Date(Date.now() + 86_400_000),
      verifiedAt: new Date(),
    })),
  );
}

test("Team holds 15 members, open invitations included, even while setting up; Business lifts it; a lapsed plan keeps everyone and adds no one", async () => {
  const owner = await stack.workspaceWithDomain();
  for (let i = 0; i < 14; i++) expect((await invite(owner.jar)).status).toBe(200);
  expect(await invite(owner.jar)).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "members", max: 15, held: 15, plan: null } },
  });

  const paid = await subscribe(owner.orgId, "business");
  expect((await invite(owner.jar)).status).toBe(200);
  expect((await api(owner.jar, "GET", "/billing")).body).toMatchObject({
    plan: "business",
    limits: { members: 75 },
    usage: { members: 16 },
  });

  await lapse(paid);
  expect((await invite(owner.jar)).status).toBe(402);
  const pending = await stack.database.db
    .select()
    .from(schema.invitations)
    .where(
      and(
        eq(schema.invitations.organizationId, owner.orgId),
        eq(schema.invitations.status, "pending"),
      ),
    );
  expect(pending).toHaveLength(15);
  expect((await api(owner.jar, "GET", "/billing")).body).toMatchObject({
    plan: null,
    readOnly: true,
  });
});

test("an invitation refused for the plan leaves no inbox behind", async () => {
  const owner = await stack.workspaceWithDomain();
  for (let i = 0; i < 14; i++) expect((await invite(owner.jar)).status).toBe(200);
  const local = `late${tag()}`;
  const refused = await api(owner.jar, "POST", "/workspace/invitations", {
    email: `late-${tag()}@elsewhere.test`,
    inbox: { domainId: owner.domainId, localPart: local },
  });
  expect(refused.status).toBe(402);
  const made = await stack.database.db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.address, `${local}@${owner.domain}`));
  expect(made).toEqual([]);
});

test("Team holds 30 inboxes: the 31st is refused before the mail host is asked; Business has room", async () => {
  const owner = await stack.workspaceWithDomain();
  const { db } = stack.database;
  await subscribe(owner.orgId, "team");
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, owner.orgId));
  for (let i = 0; i < 30; i++) {
    await createMailbox(db, owner.orgId, `box${i}-${tag()}@${owner.domain}`);
  }
  const next = () =>
    api(owner.jar, "POST", "/workspace/shared-inboxes", {
      domainId: owner.domainId,
      localPart: `next${tag()}`,
      login: {
        password: "app-password",
        imap: { host: greenmail.host, port: greenmail.imapPort },
        smtp: { host: greenmail.host, port: greenmail.smtpPort },
      },
      memberIds: [member!.id],
    });
  expect(await next()).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "mailboxes", max: 30, held: 30, plan: "team" } },
  });
  const held = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.orgId, owner.orgId));
  expect(held).toHaveLength(30);
  await db.delete(schema.subscriptions).where(eq(schema.subscriptions.orgId, owner.orgId));
  await subscribe(owner.orgId, "business");
  expect((await next()).status).not.toBe(402);
});

test("Team holds 5 domains; claiming one it holds again is not another", async () => {
  const owner = await stack.workspaceWithDomain();
  await holdDomains(owner.orgId, 4);
  const again = await api(owner.jar, "POST", "/onboarding/domains", { domain: owner.domain });
  expect(again.status).toBe(200);
  const other = `other-${tag()}.test`;
  stack.dns.addZone(other);
  expect(await api(owner.jar, "POST", "/onboarding/domains", { domain: other })).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "domains", max: 5, held: 5 } },
  });
  await subscribe(owner.orgId, "business");
  expect((await api(owner.jar, "POST", "/onboarding/domains", { domain: other })).status).toBe(200);
});

test("a domain moved into a workspace that holds its plan's domains is refused", async () => {
  const owner = await stack.workspaceWithDomain();
  await holdDomains(owner.orgId, 4);
  await authPost(stack.worker, owner.jar, "/organization/set-active", {
    organizationId: owner.homeOrgId,
  });
  const domain = `second-${tag()}.test`;
  stack.dns.addZone(domain);
  const claimed = await api(owner.jar, "POST", "/onboarding/domains", { domain });
  expect(claimed.status).toBe(200);
  stack.publishChallenge(claimed.body);
  const id = claimed.body.id as string;
  expect((await api(owner.jar, "POST", `/onboarding/domains/${id}/check`)).body).toMatchObject({
    verified: true,
  });
  const moved = await api(owner.jar, "POST", `/onboarding/domains/${id}/transfer`, {
    organizationId: owner.orgId,
  });
  expect(moved).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "domains", max: 5, held: 5 } },
  });
});

test("a month's meter counts each key once, refuses past the allowance, and a retried job runs free", async () => {
  const owner = await stack.workspaceWithDomain();
  const { db } = stack.database;
  const periodStart = new Date(Date.UTC(2026, 10, 1));
  const claim = (key: string, amount = 1, always = false) =>
    claimUsage(db, {
      orgId: owner.orgId,
      periodStart,
      meter: "meetingMinutes",
      key,
      amount,
      allowance: 60,
      always,
    });
  expect(await Promise.all(["a", "b", "c"].map((k) => claim(k, 20)))).toEqual([
    "counted",
    "counted",
    "counted",
  ]);
  expect(await claim("a", 20)).toBe("already");
  expect(await claim("d", 1)).toBe("over");
  expect(await claim("d", 45, true)).toBe("counted");
  const rows = await db
    .select()
    .from(schema.usageClaims)
    .where(eq(schema.usageClaims.orgId, owner.orgId));
  expect(rows.map((r) => r.amount).reduce((a, b) => a + b, 0)).toBe(105);
});

test("a Personal space, which has no plan yet, is held to no member cap", async () => {
  const jar = new CookieJar();
  const email = `solo-${tag()}@gmail.test`;
  await signIn(stack.worker, stack.database.db, email, jar);
  const orgId = await justMe(stack.worker, jar);
  const [owner] = await stack.database.db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(eq(schema.members.organizationId, orgId));
  await stack.database.db.insert(schema.invitations).values(
    Array.from({ length: 15 }, () => ({
      id: randomUUID(),
      organizationId: orgId,
      email: `held-${tag()}@elsewhere.test`,
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: owner!.userId,
    })),
  );
  expect((await invite(jar)).status).toBe(200);
});

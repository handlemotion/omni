import { randomUUID } from "node:crypto";
import { claimUsage, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { greenmail, type OnboardingStack, startOnboardingStack } from "./onboarding-stack.ts";
import { BILLING_SECRETS, PLAN_PRICES } from "./stripe-events.ts";
import { authPost, createMailbox } from "./support.ts";

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

test("Free holds 3 members, open invitations included; Team lifts it, and lapsing keeps everyone but adds no one", async () => {
  const owner = await stack.workspaceWithDomain();
  expect((await api(owner.jar, "GET", "/billing")).body).toMatchObject({
    plan: "free",
    limits: { members: 3 },
    usage: { members: 1 },
  });
  expect((await invite(owner.jar)).status).toBe(200);
  expect((await invite(owner.jar)).status).toBe(200);
  const refused = await invite(owner.jar);
  expect(refused.status).toBe(402);
  expect(refused.body).toMatchObject({
    code: "PLAN_LIMIT",
    details: { cap: "members", max: 3, held: 3, plan: "free" },
  });

  const paid = await subscribe(owner.orgId, "team");
  expect((await invite(owner.jar)).status).toBe(200);
  expect((await api(owner.jar, "GET", "/billing")).body).toMatchObject({
    plan: "team",
    usage: { members: 4 },
  });

  await lapse(paid);
  expect((await invite(owner.jar)).status).toBe(402);
  const held = await stack.database.db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.organizationId, owner.orgId));
  expect(held.filter((i) => i.status === "pending")).toHaveLength(3);
  expect((await api(owner.jar, "GET", "/billing")).body).toMatchObject({
    plan: "free",
    readOnly: false,
    usage: { members: 4 },
  });
});

test("an invitation refused for the plan leaves no inbox behind", async () => {
  const owner = await stack.workspaceWithDomain();
  for (let i = 0; i < 2; i++) expect((await invite(owner.jar)).status).toBe(200);
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

test("Free holds 5 inboxes: the sixth is refused before the mail host is asked; a paid plan has room", async () => {
  const owner = await stack.workspaceWithDomain();
  const { db } = stack.database;
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, owner.orgId));
  for (let i = 0; i < 5; i++)
    await createMailbox(db, owner.orgId, `box${i}-${tag()}@${owner.domain}`);
  const sixth = () =>
    api(owner.jar, "POST", "/workspace/shared-inboxes", {
      domainId: owner.domainId,
      localPart: `six${tag()}`,
      login: {
        password: "app-password",
        imap: { host: greenmail.host, port: greenmail.imapPort },
        smtp: { host: greenmail.host, port: greenmail.smtpPort },
      },
      memberIds: [member!.id],
    });
  const refused = await sixth();
  expect(refused).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "mailboxes", max: 5 } },
  });
  const before = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.orgId, owner.orgId));
  expect(before).toHaveLength(5);
  await subscribe(owner.orgId, "team");
  expect((await sixth()).status).not.toBe(402);
});

test("Free holds 1 domain; claiming the same one again is not a second", async () => {
  const owner = await stack.workspaceWithDomain();
  const again = await api(owner.jar, "POST", "/onboarding/domains", { domain: owner.domain });
  expect(again.status).toBe(200);
  const other = `other-${tag()}.test`;
  stack.dns.addZone(other);
  const refused = await api(owner.jar, "POST", "/onboarding/domains", { domain: other });
  expect(refused).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "domains", max: 1, held: 1 } },
  });
  await subscribe(owner.orgId, "team");
  expect((await api(owner.jar, "POST", "/onboarding/domains", { domain: other })).status).toBe(200);
});

test("Free holds 500 CRM records, archived ones and a person's new company included; a paid plan has no limit", async () => {
  const owner = await stack.workspaceWithDomain();
  const { db } = stack.database;
  await db.insert(schema.crmPeople).values(
    Array.from({ length: 499 }, (_, i) => ({
      orgId: owner.orgId,
      name: `Person ${i}`,
      ...(i % 2 ? { archivedAt: new Date() } : {}),
    })),
  );
  const add = (address: string) => api(owner.jar, "POST", "/crm/people", { name: "Ana", address });
  const withCompany = await add(`ana-${tag()}@newco-${tag()}.test`);
  expect(withCompany).toMatchObject({
    status: 402,
    body: { code: "PLAN_LIMIT", details: { cap: "crmRecords", max: 500, held: 499 } },
  });
  const webmail = `ana-${tag()}@gmail.com`;
  expect((await add(webmail)).status).toBe(201);
  expect((await add(webmail)).status).not.toBe(402);
  const company = await api(owner.jar, "POST", "/crm/companies", { name: "Client Co" });
  expect(company).toMatchObject({ status: 402, body: { details: { held: 500 } } });
  await subscribe(owner.orgId, "business");
  expect((await add(`ana-${tag()}@client.test`)).status).toBe(201);
});

test("adds at once cannot both take the last CRM place", async () => {
  const owner = await stack.workspaceWithDomain();
  await stack.database.db
    .insert(schema.crmPeople)
    .values(Array.from({ length: 499 }, (_, i) => ({ orgId: owner.orgId, name: `Person ${i}` })));
  const answers = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      api(owner.jar, "POST", "/crm/companies", { name: `Client ${i}` }),
    ),
  );
  expect(answers.map((a) => a.status).toSorted()).toEqual([201, 402, 402, 402, 402, 402]);
  const companies = await stack.database.db
    .select()
    .from(schema.crmCompanies)
    .where(eq(schema.crmCompanies.orgId, owner.orgId));
  expect(companies).toHaveLength(1);
});

test("a domain moved into a Free workspace that already holds one is refused", async () => {
  const owner = await stack.workspaceWithDomain();
  const switched = await authPost(stack.worker, owner.jar, "/organization/set-active", {
    organizationId: owner.homeOrgId,
  });
  expect(switched.status).toBe(200);
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
    body: { code: "PLAN_LIMIT", details: { cap: "domains", max: 1, held: 1 } },
  });
});

test("a person owns at most 2 Free workspaces; paying for one makes room for another", async () => {
  const owner = await stack.signedInOwner();
  const create = () =>
    authPost(stack.worker, owner.jar, "/organization/create", {
      name: "Side",
      slug: `side-${tag()}`,
    });
  const second = await create();
  expect(second.status).toBe(200);
  const third = await create();
  expect(third.status).toBe(403);
  expect(await third.text()).toContain("2 workspaces on the Free plan");
  await subscribe(owner.orgId, "team");
  expect((await create()).status).toBe(200);
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

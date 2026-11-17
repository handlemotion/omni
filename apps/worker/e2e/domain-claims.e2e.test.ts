import { randomUUID } from "node:crypto";
import { enqueueAction, placeForAddress, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  greenmail,
  type OnboardingStack,
  startOnboardingStack,
  waitFor,
} from "./onboarding-stack.ts";
import { authPost, sentMail, SYSTEM_MAIL_FROM } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);
const check = (jar: Parameters<typeof api>[0], id: string) =>
  api(jar, "POST", `/onboarding/domains/${id}/check`);

async function mailTo(to: string) {
  return (await sentMail(stack.worker, to)).filter(
    (m) => m.from.includes(SYSTEM_MAIL_FROM) && !m.subject.startsWith("Sign in"),
  );
}

async function auditOf(orgId: string, domain: string) {
  const rows = await stack.database.db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.orgId, orgId), eq(schema.auditEvents.subject, domain)))
    .orderBy(schema.auditEvents.createdAt, schema.auditEvents.id);
  return rows.map((r) => r.action);
}

async function runScheduledRecheck() {
  const result = await stack.worker.server.getWorker().scheduled({ cron: "23 */6 * * *" });
  expect(result.outcome).toBe("ok");
}

test("a domain locks to the first workspace whose own challenge shows up in the domain's nameservers", async () => {
  const a = await stack.workspaceWithClaim();
  const b = await stack.signedInOwner();
  const bClaim = await api(b.jar, "POST", "/onboarding/domains", { domain: a.domain });
  expect(bClaim).toMatchObject({ status: 200, body: { status: "pending", domain: a.domain } });
  expect(bClaim.body.challenge).not.toEqual(a.claim.challenge);

  expect((await check(a.jar, a.domainId)).body).toMatchObject({
    status: "pending",
    challenge: { verified: false },
  });

  stack.publishChallenge(bClaim.body);
  expect((await check(a.jar, a.domainId)).body).toMatchObject({ status: "pending" });
  expect(stack.dns.queries).toEqual(
    expect.arrayContaining([
      { name: a.domain, type: "NS" },
      { name: `_omni-challenge.${a.domain}`, type: "TXT" },
    ]),
  );
  const bChecked = await check(b.jar, bClaim.body.id as string);
  expect(bChecked).toMatchObject({
    status: 200,
    body: { status: "verified", added: true, challenge: { verified: true } },
  });

  stack.dns.set(`_omni-challenge.${a.domain}`, "TXT", [
    (a.claim.challenge as { value: string }).value,
    (bClaim.body.challenge as { value: string }).value,
  ]);
  expect(await check(a.jar, a.domainId)).toMatchObject({
    status: 409,
    body: { error: `${a.domain} was set up by another workspace first` },
  });

  const again = await api(b.jar, "POST", "/onboarding/domains", { domain: a.domain });
  expect(again.body).toMatchObject({ id: bClaim.body.id, challenge: { value: null } });

  const [stored] = await stack.database.db
    .select({ hash: schema.domainClaims.challengeHash })
    .from(schema.domainClaims)
    .where(eq(schema.domainClaims.id, bClaim.body.id as string));
  const token = (bClaim.body.challenge as { value: string }).value.split("=")[1]!;
  expect(stored!.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored!.hash).not.toContain(token);

  expect(await auditOf(b.orgId, a.domain)).toEqual(["domain.claimed", "domain.verified"]);
  expect(await auditOf(a.orgId, a.domain)).toEqual(["domain.claimed", "domain.claim_refused"]);
  const events = await api(b.jar, "GET", `/onboarding/domains/${bClaim.body.id}/events`);
  expect((events.body.events as { action: string }[]).map((e) => e.action)).toEqual([
    "domain.claimed",
    "domain.verified",
  ]);
});

test("a domain whose mail stays at Google locks on its challenge alone; its addresses are the company's", async () => {
  const owner = await stack.signedInOwner();
  const domain = `gws-${randomUUID().slice(0, 8)}.test`;
  stack.dns.addZone(domain);
  const added = await api(owner.jar, "POST", "/onboarding/domains", { domain, host: "gmail" });
  expect(added).toMatchObject({
    status: 200,
    body: { domain, provider: "gmail", status: "pending", verified: false },
  });
  expect(added.body).toMatchObject({ records: [], challenge: { type: "TXT" } });

  stack.publishChallenge(added.body);
  expect((await check(owner.jar, added.body.id as string)).body).toMatchObject({
    status: "verified",
    provider: "gmail",
    added: true,
    verified: true,
  });
  await runScheduledRecheck();
  const [lock] = await stack.database.db
    .select({ provider: schema.mailDomains.provider, orgId: schema.mailDomains.orgId })
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.domain, domain));
  expect(lock).toEqual({ provider: "gmail", orgId: owner.orgId });
  expect(
    await placeForAddress(stack.database.db, { userId: owner.userId, address: `ana@${domain}` }),
  ).toMatchObject({ ok: true, orgId: owner.orgId, kind: "company" });
});

test("lookalike names, claims past the cap and checks past the rate limit are refused", async () => {
  const owner = await stack.workspaceWithClaim();
  expect(await api(owner.jar, "POST", "/onboarding/domains", { domain: "pаypal.com" })).toEqual({
    status: 400,
    body: {
      error: "that domain name mixes alphabets, so it could pass for another name",
      code: "BAD_REQUEST",
      category: "validation",
      retryable: false,
      requestId: expect.any(String),
    },
  });

  for (let i = 1; i < 5; i++) {
    const added = await api(owner.jar, "POST", "/onboarding/domains", {
      domain: `parked-${i}-${randomUUID().slice(0, 6)}.test`,
    });
    expect(added.status).toBe(200);
  }
  expect(
    await api(owner.jar, "POST", "/onboarding/domains", {
      domain: `one-more-${randomUUID().slice(0, 6)}.test`,
    }),
  ).toMatchObject({ status: 409, body: { error: expect.stringContaining("5 domains waiting") } });

  const statuses: number[] = [];
  while (statuses.length < 61 && !statuses.includes(429)) {
    statuses.push((await check(owner.jar, owner.domainId)).status);
  }
  expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200));
  expect(statuses.at(-1)).toBe(429);
});

test("a verified domain whose challenge leaves DNS pauses its mail until it is back, and owners hear of both", async () => {
  const { db } = stack.database;
  const a = await stack.workspaceWithDomain();
  const created = await api(a.jar, "POST", "/onboarding/mailboxes", {
    domainId: a.domainId,
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
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });

  stack.dns.set(`_omni-challenge.${a.domain}`, "TXT", []);
  await runScheduledRecheck();
  await runScheduledRecheck();
  const [lock] = await db
    .select({ dnsLostAt: schema.mailDomains.dnsLostAt, orgId: schema.mailDomains.orgId })
    .from(schema.mailDomains)
    .where(eq(schema.mailDomains.domain, a.domain));
  expect(lock).toMatchObject({ orgId: a.orgId, dnsLostAt: expect.any(Date) });
  expect(await auditOf(a.orgId, a.domain)).toEqual([
    "domain.claimed",
    "domain.verified",
    "domain.dns_lost",
  ]);
  expect((await mailTo(a.email)).map((m) => m.subject)).toEqual([
    `Sending from ${a.domain} is paused`,
  ]);
  const status = await api(a.jar, "GET", "/onboarding");
  expect((status.body.domains as Record<string, unknown>[])[0]).toMatchObject({
    domain: a.domain,
    status: "verified",
    dnsLost: true,
    challenge: { verified: false },
  });

  const subject = `Paused ${randomUUID().slice(0, 8)}`;
  const to = `reader-${randomUUID().slice(0, 8)}@outside.test`;
  const action = await enqueueAction(db, {
    orgId: a.orgId,
    mailboxId,
    memberId: null,
    kind: "send",
    idempotencyKey: `paused-${subject}`,
    payload: { from: `hello@${a.domain}`, to: [to], subject, text: "Held until DNS is back." },
  });
  const actionRow = async () =>
    (await db.select().from(schema.mailActions).where(eq(schema.mailActions.id, action.id)))[0]!;
  stack.service.supervisor.ping();
  await waitFor(async () => (await actionRow()).runAfter.getTime() > Date.now() + 60_000);
  expect(await actionRow()).toMatchObject({ status: "pending", attempts: 0, smtpAcceptedAt: null });

  stack.publishChallenge(a.claim);
  await runScheduledRecheck();
  expect((await mailTo(a.email)).map((m) => m.subject)).toEqual([
    `Sending from ${a.domain} is paused`,
    `Sending from ${a.domain} is back on`,
  ]);
  await db
    .update(schema.mailActions)
    .set({ runAfter: new Date() })
    .where(eq(schema.mailActions.id, action.id));
  stack.service.supervisor.ping();
  await waitFor(async () => (await actionRow()).status === "done");
  const inbox = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
    secure: false,
    auth: { user: to, pass: "any" },
    logger: false,
  });
  await inbox.connect();
  try {
    await inbox.mailboxOpen("INBOX");
    const found = await inbox.search({ subject });
    expect(found).toHaveLength(1);
  } finally {
    await inbox.logout();
  }
});

test("an owner moves a domain to another workspace they run or releases it, and owners are told", async () => {
  const a = await stack.workspaceWithDomain();
  const stranger = await stack.signedInOwner();
  expect(
    (
      await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/transfer`, {
        organizationId: stranger.orgId,
      })
    ).status,
  ).toBe(403);

  const moved = await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/transfer`, {
    organizationId: a.homeOrgId,
  });
  expect(moved).toEqual({ status: 200, body: { transferred: true, organizationId: a.homeOrgId } });
  expect((await api(a.jar, "GET", "/onboarding")).body.domains).toEqual([]);
  expect(await auditOf(a.orgId, a.domain)).toEqual([
    "domain.claimed",
    "domain.verified",
    "domain.transferred_out",
  ]);
  expect(await auditOf(a.homeOrgId, a.domain)).toEqual(["domain.transferred_in"]);
  expect((await mailTo(a.email)).filter((m) => m.subject.includes("moved"))).toHaveLength(2);

  const active = await authPost(stack.worker, a.jar, "/organization/set-active", {
    organizationId: a.homeOrgId,
  });
  expect(active.status).toBe(200);
  const home = await api(a.jar, "GET", "/onboarding");
  expect(home.body.domains).toEqual([
    expect.objectContaining({ id: a.domainId, domain: a.domain, status: "verified" }),
  ]);
  const released = await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/release`);
  expect(released).toEqual({ status: 200, body: { released: true } });
  expect((await mailTo(a.email)).map((m) => m.subject)).toContain(`${a.domain} was released`);

  const claimed = await api(stranger.jar, "POST", "/onboarding/domains", { domain: a.domain });
  expect(claimed.body).toMatchObject({ status: "pending" });
  stack.publishChallenge(claimed.body);
  expect((await check(stranger.jar, claimed.body.id as string)).body).toMatchObject({
    status: "verified",
  });
});

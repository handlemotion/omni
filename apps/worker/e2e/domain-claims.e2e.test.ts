// Domain claims end to end (ADR 0010): Omni's `_omni-challenge` TXT read from the domain's own
// nameservers (the local authoritative DNS server), the lock, lookalikes, limits, lost DNS pausing
// real sends through GreenMail, and hand-overs between workspaces. Real Worker, real mail service,
// Postgres; nothing mocked.
import { randomUUID } from "node:crypto";
import { enqueueAction, schema } from "@omni/db";
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

/** Domain notices the Worker sent to `to` through its EMAIL binding (not sign-in links). */
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

/** The cron trigger, run the way Cloudflare runs it. */
async function runScheduledRecheck() {
  const result = await stack.worker.server.getWorker().scheduled({ cron: "23 */6 * * *" });
  expect(result.outcome).toBe("ok");
}

test("a domain locks to the first workspace whose own challenge shows up in the domain's nameservers", async () => {
  const a = await stack.workspaceWithClaim();
  const b = await stack.signedInOwner();
  // A pending claim blocks nobody: B may claim the same domain while A waits.
  const bClaim = await api(b.jar, "POST", "/onboarding/domains", { domain: a.domain });
  expect(bClaim).toMatchObject({ status: 200, body: { status: "pending", domain: a.domain } });
  expect(bClaim.body.challenge).not.toEqual(a.claim.challenge);

  // Nothing published yet: still pending.
  expect((await check(a.jar, a.domainId)).body).toMatchObject({
    status: "pending",
    challenge: { verified: false },
  });

  // B publishes B's value. It does not verify A's claim, however the record is found.
  stack.publishChallenge(bClaim.body);
  expect((await check(a.jar, a.domainId)).body).toMatchObject({ status: "pending" });
  // It was read from the zone's nameserver: an NS lookup, then the TXT asked directly.
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

  // A publishes too, too late: the lock is B's.
  stack.dns.set(`_omni-challenge.${a.domain}`, "TXT", [
    (a.claim.challenge as { value: string }).value,
    (bClaim.body.challenge as { value: string }).value,
  ]);
  expect(await check(a.jar, a.domainId)).toMatchObject({
    status: 409,
    body: { error: `${a.domain} was set up by another workspace first` },
  });

  // Claiming again returns the same claim without a new value: the published one stays valid.
  const again = await api(b.jar, "POST", "/onboarding/domains", { domain: a.domain });
  expect(again.body).toMatchObject({ id: bClaim.body.id, challenge: { value: null } });

  // Only a hash is stored.
  const [stored] = await stack.database.db
    .select({ hash: schema.domainClaims.challengeHash })
    .from(schema.domainClaims)
    .where(eq(schema.domainClaims.id, bClaim.body.id as string));
  const token = (bClaim.body.challenge as { value: string }).value.split("=")[1]!;
  expect(stored!.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored!.hash).not.toContain(token);

  expect(await auditOf(b.orgId, a.domain)).toEqual(["domain.claimed", "domain.verified"]);
  expect(await auditOf(a.orgId, a.domain)).toEqual(["domain.claimed", "domain.claim_refused"]);
  // Owners and admins read the same history through the API.
  const events = await api(b.jar, "GET", `/onboarding/domains/${bClaim.body.id}/events`);
  expect((events.body.events as { action: string }[]).map((e) => e.action)).toEqual([
    "domain.claimed",
    "domain.verified",
  ]);
});

test("lookalike names, claims past the cap and checks past the rate limit are refused", async () => {
  const owner = await stack.workspaceWithClaim();
  // A Cyrillic "а" in "pаypal": it reads as a name some other workspace may own.
  expect(await api(owner.jar, "POST", "/onboarding/domains", { domain: "pаypal.com" })).toEqual({
    status: 400,
    body: { error: "that domain name mixes alphabets, so it could pass for another name" },
  });

  // Five pending claims at once, then no more until one finishes or expires.
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

  // Checks are limited per workspace (30 a minute): a script looping on the button stops. The
  // limiter counts in fixed one-minute windows, so a run that crosses a window boundary starts
  // counting again: the first 30 always pass, and within 61 a refusal must come, since at most
  // one boundary falls inside a run this short.
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

  // The record is removed at the DNS host; the scheduled re-check finds it gone.
  stack.dns.set(`_omni-challenge.${a.domain}`, "TXT", []);
  await runScheduledRecheck();
  // Run twice, as a retried cron would: one change, one audit event, one email.
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

  // A send from the domain waits: not sent, not failed, no attempt spent.
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

  // The record is back: the next re-check restores sending and says so.
  stack.publishChallenge(a.claim);
  await runScheduledRecheck();
  expect((await mailTo(a.email)).map((m) => m.subject)).toEqual([
    `Sending from ${a.domain} is paused`,
    `Sending from ${a.domain} is back on`,
  ]);
  // Due now (instead of in five minutes), the held send goes out.
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
  // To a workspace the caller is not in: refused.
  const stranger = await stack.signedInOwner();
  expect(
    (
      await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/transfer`, {
        organizationId: stranger.orgId,
      })
    ).status,
  ).toBe(403);

  // To the owner's first workspace: the lock moves, with its verified challenge.
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
  // The same person owns both, so they get one email for each side.
  expect((await mailTo(a.email)).filter((m) => m.subject.includes("moved"))).toHaveLength(2);

  // In the first workspace it is verified already and can be released.
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

  // Released: the stranger's workspace can now claim and verify it.
  const claimed = await api(stranger.jar, "POST", "/onboarding/domains", { domain: a.domain });
  expect(claimed.body).toMatchObject({ status: "pending" });
  stack.publishChallenge(claimed.body);
  expect((await check(stranger.jar, claimed.body.id as string)).body).toMatchObject({
    status: "verified",
  });
});

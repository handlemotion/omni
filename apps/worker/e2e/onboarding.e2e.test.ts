import { randomUUID } from "node:crypto";
import { PROVISION_MAILBOX_PATH } from "@omni/contracts";
import { schema } from "@omni/db";
import { openCredentials } from "@omni/mail";
import { and, eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  greenmail,
  login,
  type OnboardingStack,
  startOnboardingStack,
  waitFor,
} from "./onboarding-stack.ts";
import { authPost, CookieJar, createMember, invite, signIn } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);
const signedInOwner = () => stack.signedInOwner();
const workspaceWithDomain = () => stack.workspaceWithDomain();

test("an owner creates a workspace, adds a domain and a mailbox that syncs, and invites", async () => {
  const { db } = stack.database;
  const owner = await signedInOwner();
  expect(await api(owner.jar, "GET", "/onboarding")).toMatchObject({
    status: 200,
    body: { canCreateOrganization: true, organization: { name: owner.name, role: "owner" } },
  });

  const { jar, orgId, domain, domainId } = await workspaceWithDomain();
  const status = await api(jar, "GET", "/onboarding");
  expect(status.body).toMatchObject({
    organization: { id: orgId, name: "Acme", role: "owner" },
    domains: [{ id: domainId, domain }],
    mailboxes: [],
  });
  const me = await api(jar, "GET", "/me");
  expect(me.body).toMatchObject({ orgId, role: "owner" });

  const mailboxBody = {
    domainId,
    localPart: "Hello",
    login: {
      password: "app-password-1",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  };
  const created = await api(jar, "POST", "/onboarding/mailboxes", mailboxBody);
  expect(created).toMatchObject({
    status: 200,
    body: { address: `hello@${domain}`, created: true },
  });
  const mailboxId = created.body.mailboxId as string;

  const rows = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.orgId, orgId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: mailboxId,
    address: `hello@${domain}`,
    kind: "shared",
    provider: "imap",
  });
  expect(rows[0]!.credentialsEnc).not.toContain("app-password-1");
  expect(await openCredentials(stack.keyring, mailboxId, rows[0]!.credentialsEnc)).toEqual(
    login(`hello@${domain}`, "app-password-1"),
  );
  const access = await db
    .select()
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  expect(access).toEqual([expect.objectContaining({ orgId, memberId: me.body.id, role: "owner" })]);

  await waitFor(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });
  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  await transport.sendMail({
    from: "someone@outside.test",
    to: `hello@${domain}`,
    subject: "First mail",
    text: "Welcome to the new inbox.",
  });
  transport.close();
  await waitFor(async () => {
    const found = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.mailboxId, mailboxId), eq(schema.messages.subject, "First mail")),
      );
    return found.length === 1;
  });

  const again = await api(jar, "POST", "/onboarding/mailboxes", mailboxBody);
  expect(again.body).toEqual({ mailboxId, address: `hello@${domain}`, created: false });
  expect(
    await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.orgId, orgId)),
  ).toHaveLength(1);
  expect((await api(jar, "GET", "/onboarding")).body.mailboxes).toEqual([
    {
      id: mailboxId,
      address: `hello@${domain}`,
      kind: "shared",
      provider: "imap",
      status: "active",
    },
  ]);

  const changed = await api(jar, "POST", "/onboarding/mailboxes", {
    ...mailboxBody,
    login: { ...mailboxBody.login, password: "app-password-2" },
  });
  expect(changed.body).toEqual({ mailboxId, address: `hello@${domain}`, created: true });
  const [stored] = await db
    .select({ enc: schema.mailboxes.credentialsEnc })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId));
  expect(await openCredentials(stack.keyring, mailboxId, stored!.enc)).toMatchObject({
    pass: "app-password-2",
  });
  await waitFor(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });

  const invited = await invite(stack.worker, jar, {
    email: `ana@${domain}`,
    role: "member",
    sharedInboxIds: [mailboxId],
  });
  expect(invited.status).toBe(200);
  const invitations = await db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.organizationId, orgId));
  expect(invitations).toEqual([
    expect.objectContaining({ email: `ana@${domain}`, role: "member", status: "pending" }),
  ]);
});

test("a domain belongs to the workspace that claimed it, and only its owners and admins set up mail", async () => {
  const a = await workspaceWithDomain();

  const b = await signedInOwner();
  const claim = await api(b.jar, "POST", "/onboarding/domains", { domain: `${a.domain}.` });
  expect(claim.status).toBe(409);
  const borrowed = await api(b.jar, "POST", "/onboarding/mailboxes", {
    domainId: a.domainId,
    localPart: "intruder",
    login: {
      password: "x",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  });
  expect(borrowed.status).toBe(404);

  const sub = await api(b.jar, "POST", "/onboarding/domains", { domain: `mail.${a.domain}` });
  expect(sub).toMatchObject({
    status: 409,
    body: { error: expect.stringContaining(`under ${a.domain}`) },
  });

  const member = await createMember(stack.database.db, a.orgId, `member@${a.domain}`);
  const memberJar = new CookieJar();
  await signIn(stack.worker, stack.database.db, `member@${a.domain}`, memberJar);
  expect((await api(memberJar, "GET", "/onboarding")).body).toMatchObject({
    organization: { id: member.organizationId, role: "member" },
    domains: [],
  });
  expect(
    (await api(memberJar, "POST", "/onboarding/domains", { domain: "other.test" })).status,
  ).toBe(403);

  const offDomain = await api(a.jar, "POST", "/onboarding/mailboxes", {
    domainId: a.domainId,
    localPart: "rodrigo@elsewhere.test",
    login: {
      password: "x",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  });
  expect(offDomain.status).toBe(400);
});

test("a mailbox login can't point at the mail service's own network, and a refusal reveals nothing about it", async () => {
  const a = await workspaceWithDomain();
  const smtp = { host: greenmail.host, port: greenmail.smtpPort };
  const attempt = (imap: { host: string; port: number }, smtpServer = smtp) =>
    api(a.jar, "POST", "/onboarding/mailboxes", {
      domainId: a.domainId,
      localPart: "probe",
      login: { password: "x", imap, smtp: smtpServer },
    });
  const refused = (host: string) => ({
    status: 422,
    body: { error: `${host} isn't a public mail server Omni can connect to` },
  });

  for (const host of ["127.0.0.1", "::1", "169.254.169.254", "10.0.0.1", "::ffff:127.0.0.1"]) {
    expect(await attempt({ host, port: 54329 })).toMatchObject(refused(host));
  }
  expect(
    await attempt(
      { host: greenmail.host, port: greenmail.imapPort },
      { host: "fdaa::3", port: 25 },
    ),
  ).toMatchObject(refused("fdaa::3"));

  expect(await attempt({ host: greenmail.host, port: 1 })).toMatchObject({
    status: 422,
    body: { error: `Couldn't reach an IMAP server at ${greenmail.host}:1` },
  });
  const saved = await stack.database.db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.address, `probe@${a.domain}`));
  expect(saved).toEqual([]);
});

test("a brand-new sign-up with no invitation creates its own workspace through onboarding", async () => {
  const email = `founder-${randomUUID().slice(0, 8)}@solo.test`;
  const jar = new CookieJar();
  await signIn(stack.worker, stack.database.db, email, jar);
  expect((await api(jar, "GET", "/me")).status).toBe(200);
  expect(await api(jar, "GET", "/onboarding")).toEqual({
    status: 200,
    body: {
      canCreateOrganization: true,
      billing: { enabled: false },
      organization: null,
      domains: [],
      mailboxes: [],
    },
  });

  const created = await authPost(stack.worker, jar, "/organization/create", {
    name: "Solo",
    slug: `solo-${randomUUID().slice(0, 8)}`,
  });
  expect(created.status).toBe(200);
  const orgId = ((await created.json()) as { id: string }).id;
  expect((await api(jar, "GET", "/me")).body).toMatchObject({ orgId, role: "owner" });

  const domain = `solo-${randomUUID().slice(0, 8)}.test`;
  stack.dns.addZone(domain);
  const added = await api(jar, "POST", "/onboarding/domains", { domain });
  expect(added.status).toBe(200);
  stack.publishChallenge(added.body);
  const checked = await api(jar, "POST", `/onboarding/domains/${added.body.id as string}/check`);
  expect(checked.body).toMatchObject({ status: "verified" });
  const mailbox = await api(
    jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(added.body.id as string, "hello"),
  );
  expect(mailbox).toMatchObject({ status: 200, body: { address: `hello@${domain}` } });
  expect((await api(jar, "POST", "/onboarding/complete")).body).toEqual({ setup: "complete" });
  expect((await api(jar, "GET", "/me")).body).toMatchObject({
    orgId,
    role: "owner",
    setup: "complete",
  });
});

test("the mail service's provisioning routes refuse unsigned calls", async () => {
  const response = await fetch(new URL(PROVISION_MAILBOX_PATH, stack.mailServiceUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(401);
});

function imapMailbox(domainId: string, localPart: string) {
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

async function setupStep(jar: CookieJar) {
  const status = await api(jar, "GET", "/onboarding");
  const me = await api(jar, "GET", "/me");
  expect(me.body.setup).toBe((status.body.organization as { setup: string }).setup);
  return me.body.setup;
}

test("setup is saved per workspace, resumes at its step, and never goes backwards on retries", async () => {
  const owner = await signedInOwner();
  const created = await authPost(stack.worker, owner.jar, "/organization/create", {
    name: "Resume Co",
    slug: `resume-${randomUUID().slice(0, 8)}`,
  });
  const orgId = ((await created.json()) as { id: string }).id;

  const listed = await api(owner.jar, "GET", "/workspaces");
  expect(listed.body.activeOrganizationId).toBe(orgId);
  expect(listed.body.workspaces).toContainEqual(
    expect.objectContaining({
      id: orgId,
      name: "Resume Co",
      role: "owner",
      setup: "created",
      mailboxes: [],
    }),
  );
  expect(await setupStep(owner.jar)).toBe("created");

  expect((await api(owner.jar, "POST", "/onboarding/complete")).status).toBe(409);

  const domain = `resume-${randomUUID().slice(0, 8)}.test`;
  stack.dns.addZone(domain);
  const added = await api(owner.jar, "POST", "/onboarding/domains", { domain });
  expect(await setupStep(owner.jar)).toBe("domain_added");
  const domainId = added.body.id as string;
  stack.publishChallenge(added.body);
  await api(owner.jar, "POST", `/onboarding/domains/${domainId}/check`);
  expect(await setupStep(owner.jar)).toBe("dns_verified");

  expect((await api(owner.jar, "GET", "/onboarding")).body).toMatchObject({
    organization: { id: orgId, name: "Resume Co", setup: "dns_verified" },
    domains: [{ id: domainId, domain }],
    mailboxes: [],
  });

  const mailbox = await api(
    owner.jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "hello"),
  );
  expect(mailbox.status).toBe(200);
  expect(await setupStep(owner.jar)).toBe("mailboxes_created");

  await api(owner.jar, "POST", "/onboarding/domains", { domain });
  await api(owner.jar, "POST", `/onboarding/domains/${domainId}/check`);
  const hello = await api(
    owner.jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "hello"),
  );
  expect(await setupStep(owner.jar)).toBe("mailboxes_created");

  const invited = await invite(stack.worker, owner.jar, {
    email: `ana@${domain}`,
    role: "member",
    sharedInboxIds: [hello.body.mailboxId as string],
  });
  expect(invited.status).toBe(200);
  expect(await setupStep(owner.jar)).toBe("invites_sent");
  expect((await api(owner.jar, "POST", "/onboarding/complete")).body).toEqual({
    setup: "complete",
  });
  expect((await api(owner.jar, "POST", "/onboarding/complete")).body).toEqual({
    setup: "complete",
  });
  expect(await setupStep(owner.jar)).toBe("complete");
  await api(owner.jar, "POST", "/onboarding/domains", { domain });
  expect(await setupStep(owner.jar)).toBe("complete");
});

test("an invitation sent before any mailbox exists does not skip setup steps", async () => {
  const { jar } = await workspaceWithDomain();
  const invited = await invite(stack.worker, jar, {
    email: `early-${randomUUID().slice(0, 8)}@elsewhere.test`,
    role: "member",
  });
  expect(invited.status).toBe(200);
  expect(await setupStep(jar)).toBe("dns_verified");
});

test("the switcher lists only the user's workspaces and the mailboxes their member there can open", async () => {
  const a = await workspaceWithDomain();
  const hello = await api(a.jar, "POST", "/onboarding/mailboxes", imapMailbox(a.domainId, "hello"));
  const team = await api(a.jar, "POST", "/onboarding/mailboxes", imapMailbox(a.domainId, "team"));
  const ownerView = await api(a.jar, "GET", "/workspaces");
  const acme = (ownerView.body.workspaces as { id: string; mailboxes: unknown[] }[]).find(
    (w) => w.id === a.orgId,
  );
  expect(acme?.mailboxes).toEqual([
    { id: hello.body.mailboxId, address: `hello@${a.domain}`, kind: "shared" },
    { id: team.body.mailboxId, address: `team@${a.domain}`, kind: "shared" },
  ]);
  expect(ownerView.body.workspaces).toHaveLength(2);
  expect(ownerView.body.workspaces).toContainEqual(
    expect.objectContaining({ name: a.name, setup: "created", mailboxes: [] }),
  );

  const plainEmail = `plain-${randomUUID().slice(0, 8)}@${a.domain}`;
  await createMember(stack.database.db, a.orgId, plainEmail);
  const plainJar = new CookieJar();
  await signIn(stack.worker, stack.database.db, plainEmail, plainJar);
  expect((await api(plainJar, "GET", "/workspaces")).body).toEqual({
    activeOrganizationId: a.orgId,
    scopedTo: a.orgId,
    workspaces: [expect.objectContaining({ id: a.orgId, role: "member", mailboxes: [] })],
  });

  const b = await workspaceWithDomain();
  const other = await api(b.jar, "GET", "/workspaces");
  const ids = (other.body.workspaces as { id: string }[]).map((w) => w.id);
  expect(ids).toContain(b.orgId);
  expect(ids).not.toContain(a.orgId);
  expect(JSON.stringify(other.body)).not.toContain(a.domain);

  expect((await api(new CookieJar(), "GET", "/workspaces")).status).toBe(401);
});

// Every mailbox of a workspace for its owners and admins, and creating a teammate's personal inbox
// after setup (ADR 0016), on the onboarding stack: real Worker, real mail service, GreenMail and
// Postgres. Seeing that a teammate's inbox exists must never be a way into its mail.
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
function imapMailbox(domainId: string, localPart: string, forMemberId?: string) {
  return {
    domainId,
    localPart,
    ...(forMemberId ? { forMemberId } : {}),
    login: {
      password: "app-password",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  };
}

/** A member of `orgId` with `role`, signed in (their only workspace, so it is the active one). */
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
    .select({ memberId: schema.mailboxAccess.memberId, role: schema.mailboxAccess.role })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows.toSorted((a, b) => a.memberId.localeCompare(b.memberId));
}

const visibleIds = async (jar: CookieJar) =>
  ((await api(jar, "GET", "/mailboxes")).body.mailboxes as { id: string }[]).map((m) => m.id);

test("owners and admins see every mailbox with its owner; members get 403; no mail leaks", async () => {
  const { db } = stack.database;
  const owner = await stack.workspaceWithDomain();
  const { orgId, domain, domainId, jar } = owner;
  const ownerMemberId = (await api(jar, "GET", "/me")).body.id as string;
  const ana = await teammate(orgId, `ana@${domain}`, "admin");
  const ben = await teammate(orgId, `ben@${domain}`, "member");

  // The owner's own inbox (they sign in with another address), a shared hello@ with Ana added, and Ben's inbox made for him.
  const mine = await api(
    jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "owner", ownerMemberId),
  );
  const hello = await api(jar, "POST", "/onboarding/mailboxes", imapMailbox(domainId, "hello"));
  const bens = await api(
    jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "ben", ben.id),
  );
  for (const created of [mine, hello, bens]) expect(created.status).toBe(200);
  const helloId = hello.body.mailboxId as string;
  const added = await fetch(
    new URL(`/api/mailboxes/${helloId}/members/${ana.id}`, stack.worker.url),
    {
      method: "PUT",
      headers: { cookie: jar.header, origin: "http://localhost:5173" },
    },
  );
  expect(added.status).toBe(200);

  // Mail in Ben's inbox that nobody but Ben may read.
  const [bensRow] = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, bens.body.mailboxId as string));
  await seedMessage(db, bensRow!, {
    subject: "Ben's private subject 7f3a",
    fromAddress: "client@example.test",
    uid: 1,
  });

  const expected = [
    {
      id: bens.body.mailboxId,
      address: `ben@${domain}`,
      kind: "personal",
      people: 1,
      owner: { memberId: ben.id, email: `ben@${domain}` },
    },
    { id: helloId, address: `hello@${domain}`, kind: "shared", people: 2, owner: null },
    {
      id: mine.body.mailboxId,
      address: `owner@${domain}`,
      kind: "personal",
      people: 1,
      owner: { memberId: ownerMemberId, email: owner.email },
    },
  ];
  // Bug caught: the listing filtered by the caller's grants (an admin would not see Ben's
  // inbox) or naming the wrong owner (the creator instead of Ben).
  for (const manager of [jar, ana.jar]) {
    const listed = await api(manager, "GET", "/workspace/mailboxes");
    expect(listed.status).toBe(200);
    expect(listed.body.mailboxes).toMatchObject(expected);
    expect(listed.body.mailboxes).toHaveLength(3);
    // Bug caught: a listing that carries mail or the sealed login along with the mailbox.
    for (const mailbox of listed.body.mailboxes as Record<string, unknown>[]) {
      expect(Object.keys(mailbox).toSorted()).toEqual([
        "address",
        "createdAt",
        "id",
        "kind",
        "owner",
        "people",
        "provider",
        "status",
        "syncedAt",
      ]);
    }
    expect(JSON.stringify(listed.body)).not.toContain("7f3a");
    // Seeing Ben's inbox in the list is not access to it.
    expect(await visibleIds(manager)).not.toContain(bens.body.mailboxId);
  }

  // Bug caught: a plain member listing the whole workspace, other people's inboxes included.
  const refused = await api(ben.jar, "GET", "/workspace/mailboxes");
  expect(refused.status).toBe(403);
  expect(JSON.stringify(refused.body)).not.toContain(`owner@${domain}`);
});

test("an inbox made for a teammate is theirs alone, and stays theirs", async () => {
  const owner = await stack.workspaceWithDomain();
  const { orgId, domain, domainId, jar } = owner;
  const cy = await teammate(orgId, `cy@elsewhere.test`, "member");
  const ownerMemberId = (await api(jar, "GET", "/me")).body.id as string;

  // Cy signs in with another address; their inbox here is at the workspace's domain.
  const made = await api(jar, "POST", "/onboarding/mailboxes", imapMailbox(domainId, "cy", cy.id));
  expect(made).toMatchObject({ status: 200, body: { address: `cy@${domain}`, created: true } });
  const mailboxId = made.body.mailboxId as string;
  const [row] = await stack.database.db
    .select({ kind: schema.mailboxes.kind, teamId: schema.mailboxes.teamId })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId));
  // Bug caught: the creator getting the owner grant (they could read Cy's mail) or the inbox
  // being made shared (with a team the creator is on).
  expect(row).toEqual({ kind: "personal", teamId: null });
  expect(await grantsOn(mailboxId)).toEqual([{ memberId: cy.id, role: "owner" }]);
  expect(await visibleIds(cy.jar)).toContain(mailboxId);
  expect(await visibleIds(jar)).not.toContain(mailboxId);

  // Bug caught: provisioning the address again as a shared mailbox, or for someone else, which
  // would keep Cy's grant and add the creator's, turning Cy's inbox into one they can read.
  const asShared = await api(jar, "POST", "/onboarding/mailboxes", imapMailbox(domainId, "cy"));
  expect(asShared.status).toBe(409);
  const asMine = await api(
    jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "cy", ownerMemberId),
  );
  expect(asMine.status).toBe(409);
  expect(await grantsOn(mailboxId)).toEqual([{ memberId: cy.id, role: "owner" }]);

  // A shared mailbox can't be turned into someone's personal inbox its team could still read.
  const hello = await api(jar, "POST", "/onboarding/mailboxes", imapMailbox(domainId, "hello"));
  expect(hello.status).toBe(200);
  const helloForCy = await api(
    jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "hello", cy.id),
  );
  expect(helloForCy.status).toBe(409);

  // Bug caught: making an inbox for a member of another workspace.
  const other = await stack.workspaceWithDomain();
  const stranger = (await api(other.jar, "GET", "/me")).body.id as string;
  const crossed = await api(
    jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "stranger", stranger),
  );
  expect(crossed.status).toBe(404);

  // Bug caught: a plain member making inboxes (only owners and admins provision).
  const byMember = await api(
    cy.jar,
    "POST",
    "/onboarding/mailboxes",
    imapMailbox(domainId, "cy2", cy.id),
  );
  expect(byMember.status).toBe(403);
});

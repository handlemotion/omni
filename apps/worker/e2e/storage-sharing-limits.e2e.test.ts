// What bounds sharing (ADR 0034 decisions 4, 6 and 7) over the real Worker with billing on and
// invitation-only sign-up: the share-mail and link-door rate limits, the read-only gate by the
// shared item's workspace, and a grant that is not an invitation.
import { randomBytes, randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { BILLING_SECRETS, MONTHLY_PRICE } from "./stripe-events.ts";
import { authPost, CookieJar, sentMail } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      BILLING_TRIAGE_ALLOWANCE: "500",
      SIGN_UP: "invitation",
      RATE_LIMIT_STORAGE_SHARE: "2/60",
      RATE_LIMIT_STORAGE_LINK: "3/60",
    },
    secrets: BILLING_SECRETS,
  });
});
afterAll(() => stack?.stop());

const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@outside.test`;
const person = (nodeId: string, email: string) =>
  `/nodes/${nodeId}/sharing/people/${encodeURIComponent(email)}`;

/** A company on a plan (`status`), and its owner signed in. */
async function company(status: "trialing" | "canceled" = "trialing") {
  const org = await stack.company(`co-${randomUUID().slice(0, 8)}`);
  const [subscription] = await stack.db
    .insert(schema.subscriptions)
    .values({
      id: randomUUID(),
      plan: "omni",
      orgId: org.id,
      status,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 86_400_000),
    })
    .returning();
  return { org, owner: await stack.member(org.id, "owner"), subscriptionId: subscription!.id };
}

/**
 * A call to the link door from `ip`. The link limit counts per IP, so each test comes from its
 * own address and none uses up another's.
 */
async function door(ip: string, jar: CookieJar, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/storage/shared/${path}`, stack.worker.url), {
    method,
    headers: {
      cookie: jar.header,
      "cf-connecting-ip": ip,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

async function sharedFolder(owner: Person) {
  const made = await stack.api(owner.jar, "POST", "/folders", {
    name: "Shared",
    space: "personal",
  });
  const folderId = made.body.node.id as string;
  const opened = await stack.api(owner.jar, "PUT", `/nodes/${folderId}/sharing/link`, {
    linkAccess: "anyone",
  });
  return { folderId, shareId: opened.body.sharing.shareId as string };
}

// Catches: a member (or a script with their cookie) mailing strangers without end from the
// install's own no-reply address, and a limit that also blocks changing someone's role.
test("adding people past RATE_LIMIT_STORAGE_SHARE answers 429 and adds nobody; a role change still works", async () => {
  const { owner } = await company();
  const { folderId } = await sharedFolder(owner);
  const [first, second, third] = [address("one"), address("two"), address("three")];
  const add = (email: string, role = "viewer") =>
    stack.api(owner.jar, "PUT", person(folderId, email), { role });

  expect((await add(first)).status).toBe(200);
  expect((await add(second)).status).toBe(200);
  const refused = await fetch(new URL(`/api/storage${person(folderId, third)}`, stack.worker.url), {
    method: "PUT",
    headers: { cookie: owner.jar.header, "content-type": "application/json" },
    body: JSON.stringify({ role: "viewer" }),
  });
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  await refused.body?.cancel();
  expect(await sentMail(stack.worker, third)).toEqual([]);

  // Someone already there costs nothing: their role changes, limit or not.
  const changed = await add(first, "editor");
  expect(changed.status).toBe(200);
  expect(
    changed.body.sharing.people.map((p: { email: string; role: string }) => [p.email, p.role]),
  ).toEqual([
    [first, "editor"],
    [second, "viewer"],
  ]);
});

// Catches: the one route family that answers without a sign-in having no limit at all, or one
// IP's requests locking every other visitor out.
test("the link door answers 429 past RATE_LIMIT_STORAGE_LINK for that IP only", async () => {
  const { owner } = await company();
  const { shareId } = await sharedFolder(owner);
  const visitor = new CookieJar();
  const statuses = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 4; i++) {
    const response = await door("203.0.113.7", visitor, "GET", shareId);
    statuses.push(response.status);
    retryAfter = response.headers.get("retry-after");
    await response.body?.cancel();
  }
  expect(statuses).toEqual([200, 200, 200, 429]);
  expect(Number(retryAfter)).toBeGreaterThan(0);
  const guess = await door("203.0.113.7", visitor, "GET", "no-such-link-0123456789ab");
  expect(guess.status).toBe(429);
  expect((await door("203.0.113.8", visitor, "GET", shareId)).status).toBe(200);
});

// Catches: an unpaid company's links going dark (nothing is taken away for not paying), an
// unpaid company still being written to or re-shared through a side door, and the gate reading
// the visitor's workspace instead of the item's.
test("a read-only workspace still serves its link; changes and sharing answer 402, by the item's workspace", async () => {
  const lapsed = await company();
  const { folderId, shareId } = await sharedFolder(lapsed.owner);
  const bytes = randomBytes(2000);
  const file = await stack.upload(lapsed.owner.jar, { parentId: folderId }, "report.pdf", bytes);
  // The editor is the owner of another company, in good standing.
  const paying = await company();
  const editor = paying.owner;
  expect(
    (await stack.api(lapsed.owner.jar, "PUT", person(folderId, editor.email), { role: "editor" }))
      .status,
  ).toBe(200);
  const other = await sharedFolder(editor);
  await stack.api(editor.jar, "PUT", person(other.folderId, lapsed.owner.email), {
    role: "editor",
  });

  await stack.db
    .update(schema.subscriptions)
    .set({ status: "canceled" })
    .where(eq(schema.subscriptions.id, lapsed.subscriptionId));

  // Reads go on: the visitor's download, the editor's listing, the owner's view of who has it.
  const download = await door(
    "203.0.113.20",
    new CookieJar(),
    "GET",
    `${shareId}/files/${file.id}/content`,
  );
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect((await door("203.0.113.21", editor.jar, "GET", shareId)).status).toBe(200);
  expect((await stack.api(lapsed.owner.jar, "GET", `/nodes/${folderId}/sharing`)).status).toBe(200);

  const changes = [
    await door("203.0.113.22", editor.jar, "POST", `${shareId}/folders`, {
      name: "New",
      parentId: folderId,
    }),
    // The owner's own link is no way round the gate either.
    await door("203.0.113.24", lapsed.owner.jar, "POST", `${shareId}/folders`, {
      name: "Mine",
      parentId: folderId,
    }),
    await door("203.0.113.22", editor.jar, "POST", `${shareId}/uploads`, {
      name: "new.bin",
      size: 1,
      parentId: folderId,
    }),
    await door("203.0.113.22", editor.jar, "PATCH", `${shareId}/nodes/${file.id}`, {
      name: "renamed.pdf",
    }),
  ];
  for (const change of changes) {
    expect(change.status).toBe(402);
    expect(await change.json()).toMatchObject({ code: "billing_inactive" });
  }
  const sharingChanges = [
    await stack.api(lapsed.owner.jar, "PUT", person(folderId, address("late")), { role: "viewer" }),
    await stack.api(lapsed.owner.jar, "DELETE", person(folderId, editor.email)),
    await stack.api(lapsed.owner.jar, "PUT", `/nodes/${folderId}/sharing/link`, { reset: true }),
  ];
  for (const change of sharingChanges) {
    expect(change).toMatchObject({ status: 402, body: { code: "billing_inactive" } });
  }
  const listed = await stack.api(lapsed.owner.jar, "GET", `/nodes?parent=${folderId}`);
  expect(listed.body.nodes.map((node: { name: string }) => node.name)).toEqual(["report.pdf"]);

  // The other way round: the lapsed company's owner still edits what a paying one shared.
  const made = await door("203.0.113.23", lapsed.owner.jar, "POST", `${other.shareId}/folders`, {
    name: "From the lapsed",
    parentId: other.folderId,
  });
  expect(made.status).toBe(201);
});

// Catches: sharing with an address quietly becoming a way into an invitation-only install.
test("with SIGN_UP=invitation a grant is not an invitation: the share mail goes out, a magic link does not", async () => {
  const { owner } = await company();
  const { folderId } = await sharedFolder(owner);
  const newcomer = address("newcomer");
  expect(
    (await stack.api(owner.jar, "PUT", person(folderId, newcomer), { role: "viewer" })).status,
  ).toBe(200);
  expect(await sentMail(stack.worker, newcomer)).toHaveLength(1);

  const asked = await authPost(stack.worker, new CookieJar(), "/sign-in/magic-link", {
    email: newcomer,
    callbackURL: "/",
  });
  expect(asked.status).toBe(200);
  await asked.body?.cancel();
  expect(await sentMail(stack.worker, newcomer)).toHaveLength(1);
  expect(
    await stack.db.select().from(schema.users).where(eq(schema.users.email, newcomer)),
  ).toEqual([]);
});

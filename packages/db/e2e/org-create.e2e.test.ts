// The `org:create` CLI as an operator runs it: a real process against a real database.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { members, organizations, users } from "../src/schema/index.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, url, teardown } = await createTestDatabase();
afterAll(teardown);

const cli = fileURLToPath(new URL("../src/cli/org-create.ts", import.meta.url));

async function orgCreate(...args: string[]) {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], {
    env: { ...process.env, DATABASE_URL: url },
  });
  return JSON.parse(stdout) as { orgId: string; userId: string; memberId: string; slug: string };
}

test("org:create makes the org, owner user and membership once, however often it runs", async () => {
  const first = await orgCreate("--name", "Acme Labs", "--owner", "Owner@Acme.test");
  const again = await orgCreate("--", "--name", "Acme Labs", "--owner", "owner@acme.test");
  expect(again).toEqual(first);
  expect(first.slug).toBe("acme-labs");

  const orgRows = await db.select().from(organizations).where(eq(organizations.slug, "acme-labs"));
  expect(orgRows).toHaveLength(1);
  const userRows = await db.select().from(users).where(eq(users.id, first.userId));
  expect(userRows.map((u) => u.email)).toEqual(["owner@acme.test"]);
  const memberRows = await db.select().from(members).where(eq(members.organizationId, first.orgId));
  expect(memberRows.map((m) => [m.userId, m.role])).toEqual([[first.userId, "owner"]]);
});

test("org:create reuses an existing user and promotes an existing member to owner", async () => {
  const org = await createOrg(db, "beta");
  const member = await createMember(db, org.id, "bea");
  const [user] = await db.select().from(users).where(eq(users.id, member.userId));

  const result = await orgCreate("--name", "Beta", "--slug", "beta", "--owner", user!.email);
  expect(result).toMatchObject({ orgId: org.id, userId: user!.id, memberId: member.id });
  const [after] = await db.select().from(members).where(eq(members.id, member.id));
  expect(after!.role).toBe("owner");
});

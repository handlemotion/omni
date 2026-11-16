// What sharing (ADR 0034 decision 4) asks of the rest of `@omni/db`, on real Postgres: a request
// made at one link stays inside it, and the sweep of abandoned sign-ups keeps the people
// something was shared with.
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { deleteAbandonedSignUps } from "../src/abandoned-sign-ups.ts";
import { forMember, forUser } from "../src/for-member.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { userEmails, users } from "../src/schema/index.ts";
import { addFile, addFolder, createPerson } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

// Catches: an editor in two workspaces writing into one of them through the other's link, which
// is how a read-only workspace would be written to past its own gate.
test("the grant door under a link reaches that link's folder and nothing else the person was given", async () => {
  const paid = await createOrg(db, "paid");
  const ana = forMember(db, (await createMember(db, paid.id, "ana")).id).storage;
  const unpaid = await createOrg(db, "unpaid");
  const bea = forMember(db, (await createMember(db, unpaid.id, "bea")).id).storage;
  const open = await addFolder(ana, { space: "personal" }, "Open");
  const inside = await addFile(ana, { parentId: open.id }, "inside.txt");
  const closed = await addFolder(bea, { space: "personal" }, "Closed");
  const elsewhere = await addFile(bea, { parentId: closed.id }, "elsewhere.txt");

  const editor = await createPerson(db, "both@outside.test");
  await ensurePersonalSpace(db, editor.id);
  const first = await ana.putGrant(open.id, "both@outside.test", "editor");
  const second = await bea.putGrant(closed.id, "both@outside.test", "editor");
  if (first.status !== "ok" || second.status !== "ok") throw new Error("grant");
  const under = forUser(db, editor.id).storage.under(first.shareId);

  expect((await under.nodeByShareId(first.shareId))?.node.id).toBe(open.id);
  expect((await under.file(inside.id)).status).toBe("ok");
  expect((await under.createFolder({ parentId: open.id }, "New")).status).toBe("ok");
  // The other grant is real, and this door does not open it.
  expect((await forUser(db, editor.id).storage.file(elsewhere.id)).status).toBe("ok");
  expect(await under.nodeByShareId(second.shareId)).toBeNull();
  expect((await under.file(elsewhere.id)).status).toBe("not_found");
  expect((await under.createFolder({ parentId: closed.id }, "x")).status).toBe("not_found");
  expect((await under.rename(elsewhere.id, "taken.txt")).status).toBe("not_found");
  expect((await under.move(inside.id, { parentId: closed.id })).status).toBe("not_found");
  expect(
    (await under.openUpload({ parentId: closed.id }, { name: "x", size: 1, limitBytes: null }))
      .status,
  ).toBe("not_found");
});

// Catches: someone who signed up from a share mail, looked once and came back two months later
// to find their account, and with it the way to what was shared, gone.
test("an idle account something is shared with is kept; one with no grant, or an unverified address, goes", async () => {
  const org = await createOrg(db, "sharers");
  const ana = forMember(db, (await createMember(db, org.id, "ana")).id).storage;
  const file = await addFile(ana, { space: "personal" }, "deck.pdf");
  const old = new Date(Date.now() - 60 * 86_400_000);
  const person = async (name: string, emailVerified = true) => {
    const email = `${name}-${randomUUID().slice(0, 8)}@people.test`;
    const [user] = await db
      .insert(users)
      .values({ id: randomUUID(), name, email, emailVerified, createdAt: old, updatedAt: old })
      .returning();
    return user!;
  };
  const granted = await person("granted");
  const extra = await person("extra");
  const extraAddress = `extra-${randomUUID().slice(0, 8)}@gmail.test`;
  await db
    .insert(userEmails)
    .values({ userId: extra.id, email: extraAddress, verifiedAt: new Date() });
  const unproven = await person("unproven", false);
  const nobody = await person("nobody");
  // Typed with capitals: a grant is stored lowercase, like the addresses it is matched to.
  await ana.putGrant(file.id, granted.email.toUpperCase(), "viewer");
  await ana.putGrant(file.id, extraAddress, "viewer");
  await ana.putGrant(file.id, unproven.email, "viewer");

  const everyone = [granted.id, extra.id, unproven.id, nobody.id];
  const deleted = await deleteAbandonedSignUps(db, {
    idleSince: new Date(Date.now() - 86_400_000),
  });
  expect(
    deleted
      .map((user) => user.id)
      .filter((id) => everyone.includes(id))
      .toSorted(),
  ).toEqual([unproven.id, nobody.id].toSorted());
  const left = await db.select({ id: users.id }).from(users).where(inArray(users.id, everyone));
  expect(left.map((user) => user.id).toSorted()).toEqual([granted.id, extra.id].toSorted());

  // The grant removed, nothing holds the account any more.
  await ana.removeGrant(file.id, granted.email);
  const later = await deleteAbandonedSignUps(db, { idleSince: new Date(Date.now() - 86_400_000) });
  expect(later.map((user) => user.id)).toContain(granted.id);
});

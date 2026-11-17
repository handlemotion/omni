import { randomUUID } from "node:crypto";
import type { StorageNode } from "@omni/contracts";
import { forMember, schema, storageObjectKey } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { authPost, CookieJar, signIn } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

async function folder(person: Person, place: object, name: string) {
  const made = await stack.api(person.jar, "POST", "/folders", { name, ...place });
  if (made.status !== 201) throw new Error(`folder ${name}: ${made.status}`);
  return made.body.node as StorageNode;
}

async function lock(person: Person, nodeId: string) {
  const locked = await forMember(stack.db, person.id).storage.lock(nodeId);
  if (locked.status !== "ok") throw new Error(`lock: ${locked.status}`);
}

async function tryEverything(jar: CookieJar, nodeId: string, moveTo: string, base = "") {
  return [
    await stack.api(jar, "PATCH", `${base}/nodes/${nodeId}`, { name: "renamed.pdf" }),
    await stack.api(jar, "PATCH", `${base}/nodes/${nodeId}`, { parentId: moveTo }),
    await stack.api(jar, "DELETE", `${base}/nodes/${nodeId}`),
    await stack.api(jar, "DELETE", `${base}/nodes/${nodeId}?forever=1`),
  ].map((answer) => [answer.status, answer.body?.code]);
}

test("a locked file answers 409 locked to rename, move, trash and delete for good, for members and for editors by grant", async () => {
  const org = await stack.company(`locked-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const deals = await folder(ana, { space: "shared" }, "Deals");
  const other = await folder(ana, { space: "shared" }, "Other");
  const signed = await stack.upload(
    ana.jar,
    { parentId: deals.id },
    "signed.pdf",
    Buffer.from("x"),
  );
  await lock(ana, signed.id);

  expect(await tryEverything(ana.jar, signed.id, other.id)).toEqual([
    [409, "LOCKED"],
    [409, "LOCKED"],
    [409, "LOCKED"],
    [409, "LOCKED"],
  ]);
  const listed = await stack.api(ana.jar, "GET", `/nodes?parent=${deals.id}`);
  expect(listed.body.nodes).toMatchObject([{ name: "signed.pdf", lockedAt: expect.any(String) }]);

  const editorEmail = `editor-${randomUUID().slice(0, 8)}@outside.test`;
  const shared = await stack.api(
    ana.jar,
    "PUT",
    `/nodes/${deals.id}/sharing/people/${encodeURIComponent(editorEmail)}`,
    { role: "editor" },
  );
  expect(shared.status).toBe(200);
  const editor = new CookieJar();
  await signIn(stack.worker, stack.db, editorEmail, editor);
  const base = `/shared/${shared.body.sharing.shareId}`;
  const inner = await stack.api(editor, "POST", `${base}/folders`, {
    name: "Inner",
    parentId: deals.id,
  });
  expect(inner.status).toBe(201);
  expect(await tryEverything(editor, signed.id, inner.body.node.id, base)).toEqual([
    [409, "LOCKED"],
    [409, "LOCKED"],
    [409, "LOCKED"],
    [404, "NOT_FOUND"],
  ]);
  expect(
    await stack.db.select().from(schema.storageNodes).where(eq(schema.storageNodes.id, signed.id)),
  ).toMatchObject([{ name: "signed.pdf", parentId: deals.id, trashedAt: null }]);
});

test("a member cannot unlock; an admin can, and the file is then an ordinary file", async () => {
  const org = await stack.company(`unlock-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const admin = await stack.member(org.id, "admin");
  const file = await stack.upload(ana.jar, { space: "shared" }, "nda.pdf", Buffer.from("nda"));
  await lock(ana, file.id);

  const refused = await stack.api(ana.jar, "DELETE", `/nodes/${file.id}/lock`);
  expect(refused).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
  const stillLocked = await stack.api(ana.jar, "PATCH", `/nodes/${file.id}`, { name: "x.pdf" });
  expect(stillLocked).toMatchObject({ status: 409, body: { code: "LOCKED" } });

  const unlocked = await stack.api(admin.jar, "DELETE", `/nodes/${file.id}/lock`);
  expect(unlocked).toMatchObject({ status: 200, body: { node: { id: file.id, lockedAt: null } } });
  expect(
    await stack.db
      .select()
      .from(schema.storageLocks)
      .where(eq(schema.storageLocks.nodeId, file.id)),
  ).toEqual([]);
  const renamed = await stack.api(ana.jar, "PATCH", `/nodes/${file.id}`, { name: "nda-v2.pdf" });
  expect(renamed).toMatchObject({ status: 200, body: { node: { name: "nda-v2.pdf" } } });
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${file.id}`)).status).toBe(200);
});

test("deleting the workspace still removes locked files and their objects", async () => {
  const bucket = await stack.bucket();
  const org = await stack.company(`closing-${randomUUID().slice(0, 8)}`);
  const owner = await stack.member(org.id, "owner");
  const ben = await stack.member(org.id);
  const ours = await stack.upload(owner.jar, { space: "shared" }, "ours.pdf", Buffer.from("o"));
  const mine = await stack.upload(ben.jar, { space: "personal" }, "mine.pdf", Buffer.from("b"));
  await lock(ben, ours.id);
  await lock(ben, mine.id);

  const deleted = await authPost(stack.worker, owner.jar, "/organization/delete", {
    organizationId: org.id,
  });
  expect(deleted.status).toBe(200);
  expect(
    await stack.db.select().from(schema.storageNodes).where(eq(schema.storageNodes.orgId, org.id)),
  ).toEqual([]);
  expect(
    await stack.db.select().from(schema.storageLocks).where(eq(schema.storageLocks.orgId, org.id)),
  ).toEqual([]);
  expect(await stack.cron("47 3 * * *")).toBe("ok");
  for (const file of [ours, mine]) {
    expect(await bucket.head(storageObjectKey(org.id, file.id))).toBeNull();
  }
});

import { randomBytes } from "node:crypto";
import type { StorageNode } from "@omni/contracts";
import { schema, storageObjectKey } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIB, startStorageStack, type StorageStack } from "./storage-support.ts";
import { BILLING_SECRETS, MONTHLY_PRICE } from "./stripe-events.ts";
import { CookieJar, signIn } from "./support.ts";

const PERSONAL_BYTES = 2 * MIB;
const WORKSPACE_BYTES = 3 * MIB;

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      BILLING_TRIAGE_ALLOWANCE: "500",
      STORAGE_PERSONAL_GB: String(PERSONAL_BYTES / 1024 ** 3),
      STORAGE_MAX_GB: String(WORKSPACE_BYTES / 1024 ** 3),
      STORAGE_MAX_FILE_BYTES: String(3 * MIB),
    },
    secrets: BILLING_SECRETS,
  });
});
afterAll(() => stack?.stop());

const names = (body: { nodes: StorageNode[] }) => body.nodes.map((node) => node.name);

test("an upload that would pass the cap answers 402 and stores nothing; deleting from Trash frees the room", async () => {
  const email = `solo-${crypto.randomUUID().slice(0, 8)}@personal.test`;
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  const [space] = await stack.db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .innerJoin(schema.users, eq(schema.users.id, schema.personalSpaces.userId))
    .where(eq(schema.users.email, email));
  const orgId = space!.orgId;
  const bucket = await stack.bucket();
  const open = (name: string, size: number) =>
    stack.api(jar, "POST", "/uploads", { name, size, space: "personal" });

  const first = await stack.upload(jar, { space: "personal" }, "first.bin", randomBytes(MIB));
  const half = await open("half.bin", MIB - 10);
  expect(half.status).toBe(201);
  expect((await stack.api(jar, "GET", "/usage")).body).toEqual({
    usedBytes: MIB,
    reservedBytes: MIB - 10,
    limitBytes: PERSONAL_BYTES,
    allowanceBytes: null,
    overage: null,
    uploadsBlocked: null,
  });
  const over = await open("over.bin", 11);
  expect(over).toMatchObject({ status: 402, body: { code: "STORAGE_FULL" } });
  expect((await open("fits.bin", 10)).status).toBe(201);
  expect((await stack.api(jar, "GET", "/usage")).body.uploadsBlocked).toBe("storage_full");

  expect(names((await stack.api(jar, "GET", "/nodes?space=personal")).body)).toEqual(["first.bin"]);
  const uploads = await stack.db
    .select({ name: schema.storageUploads.name })
    .from(schema.storageUploads)
    .where(eq(schema.storageUploads.orgId, orgId));
  expect(uploads.map((upload) => upload.name).toSorted()).toEqual([
    "first.bin",
    "fits.bin",
    "half.bin",
  ]);
  expect((await bucket.list({ prefix: `orgs/${orgId}/` })).objects).toEqual([
    expect.objectContaining({ key: storageObjectKey(orgId, first.id) }),
  ]);

  expect((await stack.api(jar, "DELETE", `/nodes/${first.id}`)).status).toBe(200);
  expect((await open("still.bin", 11)).status).toBe(402);
  expect((await stack.api(jar, "DELETE", `/nodes/${first.id}?forever=1`)).status).toBe(204);
  expect((await open("room.bin", MIB)).status).toBe(201);

  const huge = await open("huge.bin", 3 * MIB + 1);
  expect(huge).toMatchObject({ status: 413, body: { code: "FILE_TOO_LARGE" } });
  expect((await stack.api(jar, "GET", "/nodes?space=shared")).status).toBe(404);
});

test("a read-only workspace still lists and downloads, and every change answers 402 BILLING_INACTIVE", async () => {
  const paid = await stack.company("paid-before");
  const ana = await stack.member(paid.id, "owner");
  const [subscription] = await stack.db
    .insert(schema.subscriptions)
    .values({
      id: crypto.randomUUID(),
      plan: "omni",
      orgId: paid.id,
      status: "trialing",
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 86_400_000),
    })
    .returning();
  const bytes = randomBytes(1000);
  const file = await stack.upload(ana.jar, { space: "shared" }, "report.pdf", bytes);
  const pending = await stack.api(ana.jar, "POST", "/uploads", {
    name: "late.bin",
    size: 4,
    space: "shared",
  });
  await stack.db
    .update(schema.subscriptions)
    .set({ status: "canceled" })
    .where(eq(schema.subscriptions.id, subscription!.id));

  expect(names((await stack.api(ana.jar, "GET", "/nodes?space=shared")).body)).toEqual([
    "report.pdf",
  ]);
  const download = await stack.download(ana.jar, file.id);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect((await stack.api(ana.jar, "GET", "/trash")).status).toBe(200);
  expect((await stack.api(ana.jar, "GET", "/usage")).body).toMatchObject({
    usedBytes: 1000,
    uploadsBlocked: "billing_inactive",
  });

  const uploadId = pending.body.upload.id as string;
  const changes = [
    await stack.api(ana.jar, "POST", "/uploads", { name: "new.bin", size: 1, space: "shared" }),
    await stack.api(ana.jar, "POST", `/uploads/${uploadId}/complete`),
    await stack.api(ana.jar, "DELETE", `/uploads/${uploadId}`),
    await stack.api(ana.jar, "POST", "/folders", { name: "New", space: "shared" }),
    await stack.api(ana.jar, "PATCH", `/nodes/${file.id}`, { name: "renamed.pdf" }),
    await stack.api(ana.jar, "DELETE", `/nodes/${file.id}`),
    await stack.api(ana.jar, "POST", `/nodes/${file.id}/restore`),
  ];
  for (const change of changes) {
    expect(change).toMatchObject({ status: 402, body: { code: "BILLING_INACTIVE" } });
  }
  const part = await stack.putPart(ana.jar, uploadId, 1, randomBytes(4));
  expect(part.status).toBe(402);
  expect(names((await stack.api(ana.jar, "GET", "/nodes?space=shared")).body)).toEqual([
    "report.pdf",
  ]);
});

async function soloPerson() {
  const email = `solo-${crypto.randomUUID().slice(0, 8)}@personal.test`;
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  const [space] = await stack.db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .innerJoin(schema.users, eq(schema.users.id, schema.personalSpaces.userId))
    .where(eq(schema.users.email, email));
  return { jar, orgId: space!.orgId };
}

test("STORAGE_MAX_GB caps a company, which the Personal cap does not touch", async () => {
  const org = await stack.company("capped");
  const ana = await stack.member(org.id, "owner");
  await stack.db.insert(schema.subscriptions).values({
    id: crypto.randomUUID(),
    plan: "omni",
    orgId: org.id,
    status: "trialing",
    periodStart: new Date(),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  const open = (name: string, size: number) =>
    stack.api(ana.jar, "POST", "/uploads", { name, size, space: "shared" });

  await stack.upload(ana.jar, { space: "shared" }, "big.bin", randomBytes(PERSONAL_BYTES + 10));
  expect((await stack.api(ana.jar, "GET", "/usage")).body).toMatchObject({
    usedBytes: PERSONAL_BYTES + 10,
    limitBytes: WORKSPACE_BYTES,
    uploadsBlocked: null,
  });
  expect(await open("over.bin", MIB - 9)).toMatchObject({
    status: 402,
    body: { code: "STORAGE_FULL" },
  });
  expect((await open("fits.bin", MIB - 10)).status).toBe(201);
});

test("a complete refused as full or into a trashed folder keeps the upload, which completes later without its parts sent again", async () => {
  const { jar, orgId } = await soloPerson();
  const bucket = await stack.bucket();
  const stitched = async (place: object, bytes: Uint8Array) => {
    const opened = await stack.api(jar, "POST", "/uploads", {
      name: "x.bin",
      size: bytes.length,
      ...place,
    });
    expect(opened.status).toBe(201);
    const id = opened.body.upload.id as string;
    expect((await stack.putPart(jar, id, 1, bytes)).status).toBe(200);
    return id;
  };
  const setUsed = (bytes: number) =>
    stack.db.update(schema.storageUsage).set({ bytes }).where(eq(schema.storageUsage.orgId, orgId));
  const objects = async () =>
    (await bucket.list({ prefix: `orgs/${orgId}/` })).objects.map((object) => object.key);

  const bytes = randomBytes(100);
  const full = await stitched({ space: "personal" }, bytes);
  await setUsed(PERSONAL_BYTES);
  expect(await stack.api(jar, "POST", `/uploads/${full}/complete`)).toMatchObject({
    status: 402,
    body: { code: "STORAGE_FULL" },
  });
  expect((await stack.api(jar, "GET", `/uploads/${full}`)).body.upload.parts).toEqual([
    { partNumber: 1, size: 100 },
  ]);
  await setUsed(0);
  const done = await stack.api(jar, "POST", `/uploads/${full}/complete`);
  expect(done.status).toBe(200);
  expect(Buffer.from(await (await stack.download(jar, full)).arrayBuffer())).toEqual(bytes);
  expect(await stack.usedBytes(orgId)).toBe(100);

  const folder = await stack.api(jar, "POST", "/folders", { name: "Gone", space: "personal" });
  const orphan = await stitched({ parentId: folder.body.node.id }, randomBytes(50));
  expect((await stack.api(jar, "DELETE", `/nodes/${folder.body.node.id}`)).status).toBe(200);
  expect(await stack.api(jar, "POST", `/uploads/${orphan}/complete`)).toMatchObject({
    status: 409,
    body: { code: "PARENT_TRASHED" },
  });
  const moved = await stack.api(jar, "PATCH", `/uploads/${orphan}`, {
    space: "personal",
    name: "rescued.bin",
  });
  expect(moved.body.upload).toMatchObject({ parentId: null, name: "rescued.bin" });
  const rescued = await stack.api(jar, "POST", `/uploads/${orphan}/complete`);
  expect(rescued.body.node).toMatchObject({ id: orphan, parentId: null, name: "rescued.bin" });
  expect(await stack.usedBytes(orgId)).toBe(150);

  const dropped = await stitched({ space: "personal" }, randomBytes(10));
  await setUsed(PERSONAL_BYTES);
  expect((await stack.api(jar, "POST", `/uploads/${dropped}/complete`)).status).toBe(402);
  expect(await objects()).toContain(storageObjectKey(orgId, dropped));
  expect((await stack.api(jar, "DELETE", `/uploads/${dropped}`)).status).toBe(204);
  expect((await objects()).toSorted()).toEqual(
    [storageObjectKey(orgId, full), storageObjectKey(orgId, orphan)].toSorted(),
  );
});

// Storage's limits (ADR 0034 decision 7) over the real Worker with billing on: the cap on a
// Personal space, the cap on one file, and a read-only workspace that still downloads.
import { randomBytes } from "node:crypto";
import type { StorageNode } from "@omni/contracts";
import { schema, storageObjectKey } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIB, startStorageStack, type StorageStack } from "./storage-support.ts";
import { BILLING_SECRETS, MONTHLY_PRICE } from "./stripe-events.ts";
import { CookieJar, signIn } from "./support.ts";

/** A Personal space may hold 2 MiB here. */
const PERSONAL_BYTES = 2 * MIB;

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      BILLING_TRIAGE_ALLOWANCE: "500",
      STORAGE_PERSONAL_GB: String(PERSONAL_BYTES / 1024 ** 3),
      STORAGE_MAX_FILE_BYTES: String(3 * MIB),
    },
    secrets: BILLING_SECRETS,
  });
});
afterAll(() => stack?.stop());

const names = (body: { nodes: StorageNode[] }) => body.nodes.map((node) => node.name);

// Catches: an upload past the cap that still leaves a file, a row or an object behind, an
// upload in progress not counted (two halves each fitting, together not), Trash that never
// gives its bytes back, and a file larger than one file may be.
test("an upload that would pass the cap answers 402 and stores nothing; deleting from Trash frees the room", async () => {
  // Someone in no company: their sign-in opens their Personal space.
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
  // An upload in progress holds its room: a second MiB opens, a third byte past it does not.
  const half = await open("half.bin", MIB - 10);
  expect(half.status).toBe(201);
  expect((await stack.api(jar, "GET", "/usage")).body).toEqual({
    usedBytes: MIB,
    reservedBytes: MIB - 10,
    limitBytes: PERSONAL_BYTES,
    allowanceBytes: null,
    uploadsBlocked: null,
  });
  const over = await open("over.bin", 11);
  expect(over).toMatchObject({ status: 402, body: { code: "STORAGE_FULL" } });
  expect((await open("fits.bin", 10)).status).toBe(201);
  expect((await stack.api(jar, "GET", "/usage")).body.uploadsBlocked).toBe("STORAGE_FULL");

  // Nothing came of the refused one: no file, no upload row, no object.
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

  // In Trash it still counts; deleted for good, the room is back.
  expect((await stack.api(jar, "DELETE", `/nodes/${first.id}`)).status).toBe(200);
  expect((await open("still.bin", 11)).status).toBe(402);
  expect((await stack.api(jar, "DELETE", `/nodes/${first.id}?forever=1`)).status).toBe(204);
  expect((await open("room.bin", MIB)).status).toBe(201);

  // One file may be 3 MiB here, whatever room there is.
  const huge = await open("huge.bin", 3 * MIB + 1);
  expect(huge).toMatchObject({ status: 413, body: { code: "FILE_TOO_LARGE" } });
  // A Personal space has no Shared.
  expect((await stack.api(jar, "GET", "/nodes?space=shared")).status).toBe(404);
});

// Catches: an unpaid company locked out of its own files, or still able to add to them.
test("a read-only workspace still lists and downloads, and every change answers 402 BILLING_INACTIVE", async () => {
  const paid = await stack.company("paid-before");
  const ana = await stack.member(paid.id, "owner");
  // While in good standing (a trial), Ana uploads; then the subscription ends.
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
    uploadsBlocked: "BILLING_INACTIVE",
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

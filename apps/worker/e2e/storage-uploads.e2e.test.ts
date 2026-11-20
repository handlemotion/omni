import { randomBytes } from "node:crypto";
import { STORAGE_PART_BYTES, type StorageUpload } from "@omni/contracts";
import { schema, storageObjectKey } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIB, sha256, startStorageStack, type StorageStack } from "./storage-support.ts";

const HOUR = 60 * 60_000;

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { STORAGE_MAX_OPEN_UPLOADS: "3", STORAGE_MAX_RESERVED_BYTES: String(40 * MIB) },
  });
});
afterAll(() => stack?.stop());

async function person(name: string) {
  const org = await stack.company(`uploads-${name}-${crypto.randomUUID().slice(0, 8)}`);
  return { org, ...(await stack.member(org.id)) };
}

const twoParts = () => randomBytes(STORAGE_PART_BYTES + 1000);
const partOf = (bytes: Uint8Array, n: number) =>
  bytes.subarray((n - 1) * STORAGE_PART_BYTES, n * STORAGE_PART_BYTES);

async function open(jar: Person["jar"], bytes: Uint8Array, extra: object = {}) {
  const opened = await stack.api(jar, "POST", "/uploads", {
    name: "file.bin",
    size: bytes.length,
    space: "shared",
    ...extra,
  });
  return opened as { status: number; body: { upload: StorageUpload; code?: string } };
}
type Person = Awaited<ReturnType<typeof person>>;

async function put(jar: Person["jar"], id: string, n: number, bytes: Uint8Array) {
  const sent = await stack.putPart(jar, id, n, partOf(bytes, n));
  return { status: sent.status, body: await sent.json() };
}

const downloaded = async (jar: Person["jar"], id: string) =>
  Buffer.from(await (await stack.download(jar, id)).arrayBuffer());

test("an upload that keeps receiving parts past a day completes: each part moves its closing time", async () => {
  const ana = await person("slow");
  const bytes = twoParts();
  const { upload } = (await open(ana.jar, bytes)).body;
  await stack.db
    .update(schema.storageUploads)
    .set({ createdAt: new Date(Date.now() - 25 * HOUR), expiresAt: new Date(Date.now() + 2000) })
    .where(eq(schema.storageUploads.id, upload.id));

  const first = await put(ana.jar, upload.id, 1, bytes);
  expect(first.status).toBe(200);
  expect(Date.parse(first.body.expiresAt) - Date.now()).toBeGreaterThan(23 * HOUR);
  expect((await put(ana.jar, upload.id, 2, bytes)).status).toBe(200);
  expect((await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`)).status).toBe(200);
  expect((await downloaded(ana.jar, upload.id)).equals(bytes)).toBe(true);

  const old = (await open(ana.jar, bytes)).body.upload;
  const openedAt = Date.now() - 6 * 24 * HOUR + HOUR;
  await stack.db
    .update(schema.storageUploads)
    .set({ createdAt: new Date(openedAt) })
    .where(eq(schema.storageUploads.id, old.id));
  const capped = await put(ana.jar, old.id, 1, bytes);
  expect(Date.parse(capped.body.expiresAt)).toBe(openedAt + 6 * 24 * HOUR);
});

test("a part sent twice, one after the other and at once, still completes with the right bytes", async () => {
  const ana = await person("twice");
  const bytes = twoParts();
  const { upload } = (await open(ana.jar, bytes)).body;
  expect((await put(ana.jar, upload.id, 1, bytes)).status).toBe(200);
  const sent = await Promise.all([
    put(ana.jar, upload.id, 1, bytes),
    put(ana.jar, upload.id, 2, bytes),
    put(ana.jar, upload.id, 2, bytes),
  ]);
  expect(sent.map((each) => each.status)).toEqual([200, 200, 200]);
  expect(sent[1]!.body.part).toEqual({ partNumber: 2, size: 1000 });
  expect((await stack.api(ana.jar, "GET", `/uploads/${upload.id}`)).body.upload.parts).toEqual([
    { partNumber: 1, size: STORAGE_PART_BYTES },
    { partNumber: 2, size: 1000 },
  ]);
  expect((await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`)).status).toBe(200);
  expect((await downloaded(ana.jar, upload.id)).equals(bytes)).toBe(true);
});

test("parts the bucket will not stitch are forgotten, and the upload completes once they are sent again", async () => {
  const ana = await person("invalid-part");
  const bytes = twoParts();
  const { upload } = (await open(ana.jar, bytes)).body;
  await put(ana.jar, upload.id, 1, bytes);
  await put(ana.jar, upload.id, 2, bytes);
  await stack.db
    .update(schema.storageUploadParts)
    .set({ etag: "not-the-bucket's" })
    .where(eq(schema.storageUploadParts.partNumber, 1));

  const refused = await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`);
  expect([refused.status, refused.body.code]).toEqual([409, "UPLOAD_INCOMPLETE"]);
  expect((await stack.api(ana.jar, "GET", `/uploads/${upload.id}`)).body.upload.parts).toEqual([]);
  await put(ana.jar, upload.id, 1, bytes);
  await put(ana.jar, upload.id, 2, bytes);
  expect((await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`)).status).toBe(200);
  expect((await downloaded(ana.jar, upload.id)).equals(bytes)).toBe(true);
});

test("a sha256 the bytes do not match is refused and nothing is stored; a matching one is kept", async () => {
  const ana = await person("sha");
  const bytes = twoParts();
  const wrong = (await open(ana.jar, bytes, { sha256: sha256(randomBytes(8)) })).body.upload;
  await put(ana.jar, wrong.id, 1, bytes);
  await put(ana.jar, wrong.id, 2, bytes);
  const refused = await stack.api(ana.jar, "POST", `/uploads/${wrong.id}/complete`);
  expect([refused.status, refused.body.code]).toEqual([422, "CHECKSUM_MISMATCH"]);
  expect((await stack.api(ana.jar, "GET", `/uploads/${wrong.id}`)).status).toBe(404);
  const bucket = await stack.bucket();
  expect(await bucket.head(storageObjectKey(ana.org.id, wrong.id))).toBeNull();
  expect(await stack.usedBytes(ana.org.id)).toBe(0);

  const right = (await open(ana.jar, bytes, { sha256: sha256(bytes) })).body.upload;
  await put(ana.jar, right.id, 1, bytes);
  await put(ana.jar, right.id, 2, bytes);
  const done = await stack.api(ana.jar, "POST", `/uploads/${right.id}/complete`);
  expect(done.body.node.contentSha256).toBe(sha256(bytes));
});

test("one person may hold only so many uploads in progress, by count and by bytes", async () => {
  const ana = await person("caps");
  const small = randomBytes(10);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await open(ana.jar, small)).body.upload.id);
  const fourth = await open(ana.jar, small);
  expect([fourth.status, fourth.body.code]).toEqual([429, "TOO_MANY_UPLOADS"]);
  const bob = await stack.member(ana.org.id);
  expect((await open(bob.jar, small)).status).toBe(201);

  expect((await stack.api(ana.jar, "DELETE", `/uploads/${ids[0]}`)).status).toBe(204);
  const big = await stack.api(ana.jar, "POST", "/uploads", {
    name: "big.bin",
    size: 41 * MIB,
    space: "shared",
  });
  expect([big.status, big.body.code]).toEqual([429, "TOO_MANY_UPLOADS"]);
  expect((await open(ana.jar, small)).status).toBe(201);
});

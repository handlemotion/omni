import { randomBytes, randomUUID } from "node:crypto";
import { STORAGE_PART_BYTES, type StorageNode, type StorageUpload } from "@omni/contracts";
import { schema, storageObjectKey } from "@omni/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIB, sha256, startStorageStack, type StorageStack } from "./storage-support.ts";
import { authPost } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const names = (body: { nodes: StorageNode[] }) => body.nodes.map((node) => node.name);

test("a 40 MiB file sent in three parts, out of order and resumed, downloads byte-identical and honours Range", async () => {
  const org = await stack.company("big-file");
  const ana = await stack.member(org.id);
  const bytes = randomBytes(40 * MIB);
  const part = (n: number) => bytes.subarray((n - 1) * STORAGE_PART_BYTES, n * STORAGE_PART_BYTES);

  const opened = await stack.api(ana.jar, "POST", "/uploads", {
    name: "film.bin",
    size: bytes.length,
    space: "personal",
  });
  expect(opened.status).toBe(201);
  const upload = opened.body.upload as StorageUpload;
  expect(upload).toMatchObject({ partSize: 16 * MIB, partCount: 3, parts: [], nodeId: null });
  expect(JSON.stringify(opened.body)).not.toMatch(/r2|orgs\//i);

  const sent = await Promise.all([
    stack.putPart(ana.jar, upload.id, 3, part(3)),
    stack.putPart(ana.jar, upload.id, 2, randomBytes(STORAGE_PART_BYTES)),
  ]);
  expect(sent.map((response) => response.status)).toEqual([200, 200]);
  expect((await stack.putPart(ana.jar, upload.id, 2, part(2))).status).toBe(200);

  const short = await stack.putPart(ana.jar, upload.id, 1, part(1).subarray(0, 100));
  expect(short.status).toBe(400);
  expect(await short.json()).toMatchObject({ code: "INVALID_PART" });
  expect((await stack.putPart(ana.jar, upload.id, 4, part(3))).status).toBe(400);
  expect((await stack.putPart(ana.jar, upload.id, 0, part(3))).status).toBe(400);

  const resumed = await stack.api(ana.jar, "GET", `/uploads/${upload.id}`);
  expect(resumed.body.upload.parts).toEqual([
    { partNumber: 2, size: 16 * MIB },
    { partNumber: 3, size: 8 * MIB },
  ]);
  const early = await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`);
  expect(early).toMatchObject({ status: 409, body: { code: "UPLOAD_INCOMPLETE" } });
  expect(names((await stack.api(ana.jar, "GET", "/nodes?space=personal")).body)).toEqual([]);

  expect((await stack.putPart(ana.jar, upload.id, 1, part(1))).status).toBe(200);
  const [first, second] = await Promise.all([
    stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`),
    stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`),
  ]);
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(second.body.node.id).toBe(first.body.node.id);
  const again = await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`);
  expect(again.body.node).toMatchObject({ id: first.body.node.id, name: "film.bin" });
  expect(names((await stack.api(ana.jar, "GET", "/nodes?space=personal")).body)).toEqual([
    "film.bin",
  ]);
  expect(await stack.usedBytes(org.id)).toBe(bytes.length);
  const usage = await stack.api(ana.jar, "GET", "/usage");
  expect(usage.body).toEqual({
    usedBytes: bytes.length,
    reservedBytes: 0,
    limitBytes: null,
    allowanceBytes: null,
    overage: null,
    uploadsBlocked: null,
  });
  expect((await stack.putPart(ana.jar, upload.id, 1, part(1))).status).toBe(409);

  const nodeId = first.body.node.id as string;
  const whole = await stack.download(ana.jar, nodeId);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe(String(bytes.length));
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(sha256(new Uint8Array(await whole.arrayBuffer()))).toBe(sha256(bytes));

  const from = STORAGE_PART_BYTES - 6;
  const slice = await stack.download(ana.jar, nodeId, { range: `bytes=${from}-${from + 11}` });
  expect(slice.status).toBe(206);
  expect(slice.headers.get("content-range")).toBe(`bytes ${from}-${from + 11}/${bytes.length}`);
  expect(slice.headers.get("content-length")).toBe("12");
  expect(Buffer.from(await slice.arrayBuffer())).toEqual(bytes.subarray(from, from + 12));

  const tail = await stack.download(ana.jar, nodeId, { range: "bytes=-5" });
  expect(tail.status).toBe(206);
  expect(tail.headers.get("content-range")).toBe(
    `bytes ${bytes.length - 5}-${bytes.length - 1}/${bytes.length}`,
  );
  expect(Buffer.from(await tail.arrayBuffer())).toEqual(bytes.subarray(-5));

  const open = await stack.download(ana.jar, nodeId, { range: `bytes=${bytes.length - 3}-` });
  expect(open.headers.get("content-length")).toBe("3");
  expect(Buffer.from(await open.arrayBuffer())).toEqual(bytes.subarray(-3));
  const stale = await stack.download(ana.jar, nodeId, { range: "bytes=0-9", "if-range": '"old"' });
  expect(stale.status).toBe(200);
  await stale.body?.cancel();
  const same = await stack.download(ana.jar, nodeId, {
    range: "bytes=0-9",
    "if-range": whole.headers.get("etag")!,
  });
  expect(same.status).toBe(206);
  await same.body?.cancel();

  const past = await stack.download(ana.jar, nodeId, { range: `bytes=${bytes.length}-` });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
});

test("whatever was uploaded leaves as a download: octet-stream, attachment, nosniff, the name intact", async () => {
  const org = await stack.company("download-headers");
  const ana = await stack.member(org.id);
  const html = Buffer.from("<script>alert(document.cookie)</script>");
  const name = `résumé "final" (1)'*.html`;
  const page = await stack.upload(ana.jar, { space: "personal" }, name, html, "text/html");
  expect(page).toMatchObject({ name, mimeType: "text/html", size: html.length });

  const response = await stack.download(ana.jar, page.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  const disposition = response.headers.get("content-disposition")!;
  expect(disposition).toBe(
    `attachment; filename="r_sum_ _final_ (1)'*.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%20%281%29%27%2A.html`,
  );
  expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(name);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(html);

  const empty = await stack.upload(ana.jar, { space: "personal" }, "empty.txt", new Uint8Array(0));
  const nothing = await stack.download(ana.jar, empty.id);
  expect(nothing.status).toBe(200);
  expect(nothing.headers.get("content-length")).toBe("0");
  expect((await nothing.arrayBuffer()).byteLength).toBe(0);
  expect(
    (await fetch(new URL(`/api/storage/files/${page.id}/content`, stack.worker.url))).status,
  ).toBe(401);
});

test("nobody but its member reaches a My files folder, file or upload over HTTP: not a colleague, not an admin", async () => {
  const org = await stack.company("private");
  const ana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const admin = await stack.member(org.id, "admin");
  const owner = await stack.member(org.id, "owner");
  const secret = Buffer.from("ana's salary letter");

  const folder = (
    await stack.api(ana.jar, "POST", "/folders", { name: "Private", space: "personal" })
  ).body.node as StorageNode;
  const file = await stack.upload(ana.jar, { parentId: folder.id }, "letter.txt", secret);
  const pending = await stack.api(ana.jar, "POST", "/uploads", {
    name: "draft.bin",
    size: 3,
    parentId: folder.id,
  });
  const uploadId = pending.body.upload.id as string;

  for (const other of [ben, admin, owner]) {
    expect(names((await stack.api(other.jar, "GET", "/nodes?space=personal")).body)).toEqual([]);
    const attempts = [
      await stack.api(other.jar, "GET", `/nodes?parent=${folder.id}`),
      await stack.api(other.jar, "PATCH", `/nodes/${file.id}`, { name: "mine.txt" }),
      await stack.api(other.jar, "PATCH", `/nodes/${file.id}`, { space: "shared" }),
      await stack.api(other.jar, "DELETE", `/nodes/${file.id}`),
      await stack.api(other.jar, "DELETE", `/nodes/${file.id}?forever=1`),
      await stack.api(other.jar, "POST", `/nodes/${file.id}/restore`),
      await stack.api(other.jar, "POST", "/folders", { name: "In", parentId: folder.id }),
      await stack.api(other.jar, "POST", "/uploads", { name: "x", size: 1, parentId: folder.id }),
      await stack.api(other.jar, "GET", `/uploads/${uploadId}`),
      await stack.api(other.jar, "POST", `/uploads/${uploadId}/complete`),
      await stack.api(other.jar, "DELETE", `/uploads/${uploadId}`),
    ];
    expect(attempts.map((attempt) => attempt.status)).toEqual(attempts.map(() => 404));
    const download = await stack.download(other.jar, file.id);
    expect(download.status).toBe(404);
    expect(await download.text()).not.toContain("salary");
    expect((await stack.putPart(other.jar, uploadId, 1, Buffer.from("abc"))).status).toBe(404);
    expect(names((await stack.api(other.jar, "GET", "/trash")).body)).toEqual([]);
  }
  expect((await stack.api(ana.jar, "GET", `/nodes?parent=${folder.id}`)).body).toMatchObject({
    folder: { node: { id: folder.id }, role: "member", path: [{ id: folder.id, name: "Private" }] },
    nodes: [{ id: file.id, name: "letter.txt", trashedAt: null }],
  });
  expect(Buffer.from(await (await stack.download(ana.jar, file.id)).arrayBuffer())).toEqual(secret);

  const moved = await stack.api(ana.jar, "PATCH", `/nodes/${file.id}`, { space: "shared" });
  expect(moved.body.node).toMatchObject({ space: "shared", parentId: null, ownerMemberId: null });
  expect((await stack.download(ben.jar, file.id)).status).toBe(200);
  const outsider = await stack.member((await stack.company("elsewhere")).id, "owner");
  expect((await stack.download(outsider.jar, file.id)).status).toBe(404);
  expect(names((await stack.api(outsider.jar, "GET", "/nodes?space=shared")).body)).toEqual([]);
});

test("completing again after the file left the uploader's reach answers 404 and leaves its bytes alone", async () => {
  const org = await stack.company("retry-after-move");
  const ana = await stack.member(org.id);
  const admin = await stack.member(org.id, "admin");
  const bytes = randomBytes(2048);
  const file = await stack.upload(ana.jar, { space: "shared" }, "plan.bin", bytes);

  const moved = await stack.api(admin.jar, "PATCH", `/nodes/${file.id}`, { space: "personal" });
  expect(moved.body.node).toMatchObject({ space: "personal", ownerMemberId: admin.id });

  expect((await stack.api(ana.jar, "POST", `/uploads/${file.id}/complete`)).status).toBe(404);
  expect((await stack.api(ana.jar, "DELETE", `/uploads/${file.id}`)).status).toBe(404);

  const download = await stack.download(admin.jar, file.id);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect(await stack.usedBytes(org.id)).toBe(bytes.length);
});

test("folders, names, paging, and Trash: restore puts it back, delete forever removes the object and frees the bytes", async () => {
  const org = await stack.company("tree");
  const ana = await stack.member(org.id);
  const bucket = await stack.bucket();
  const folder = async (name: string, place: object) =>
    (await stack.api(ana.jar, "POST", "/folders", { name, ...place })).body.node as StorageNode;

  const docs = await folder("Docs", { space: "personal" });
  expect((await folder("docs", { space: "personal" })).name).toBe("docs (1)");
  const a = await stack.upload(ana.jar, { parentId: docs.id }, "a.txt", Buffer.from("aaaa"));
  const twin = await stack.upload(ana.jar, { parentId: docs.id }, "a.txt", Buffer.from("bb"));
  expect(twin.name).toBe("a (1).txt");
  const inner = await folder("Inner", { parentId: docs.id });

  const invalid = await stack.api(ana.jar, "POST", "/folders", { name: "a/b", space: "personal" });
  expect(invalid).toMatchObject({ status: 400, body: { code: "INVALID_NAME" } });
  const clash = await stack.api(ana.jar, "PATCH", `/nodes/${twin.id}`, { name: "A.TXT" });
  expect(clash).toMatchObject({ status: 409, body: { code: "NAME_TAKEN" } });
  const cycle = await stack.api(ana.jar, "PATCH", `/nodes/${docs.id}`, { parentId: inner.id });
  expect(cycle).toMatchObject({ status: 409, body: { code: "CYCLE" } });
  expect((await stack.api(ana.jar, "PATCH", `/nodes/${twin.id}`, {})).status).toBe(400);
  expect((await stack.api(ana.jar, "GET", "/nodes")).status).toBe(400);
  const renamed = await stack.api(ana.jar, "PATCH", `/nodes/${twin.id}`, { name: "b.txt" });
  expect(renamed.body.node.name).toBe("b.txt");

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `/nodes?parent=${docs.id}&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
    const page = await stack.api(ana.jar, "GET", query);
    expect(page.body.nodes.length).toBeLessThanOrEqual(2);
    seen.push(...names(page.body));
    cursor = page.body.nextCursor;
  } while (cursor);
  expect(seen).toEqual(["Inner", "a.txt", "b.txt"]);
  expect((await stack.api(ana.jar, "GET", `/nodes?parent=${docs.id}&cursor=nope`)).status).toBe(
    400,
  );

  const key = storageObjectKey(org.id, a.id);
  expect(await bucket.head(key)).toMatchObject({ size: 4 });
  const live = await stack.api(ana.jar, "DELETE", `/nodes/${a.id}?forever=1`);
  expect(live).toMatchObject({ status: 409, body: { code: "NOT_TRASHED" } });

  const trashed = await stack.api(ana.jar, "DELETE", `/nodes/${a.id}`);
  expect(trashed.body.node.trashedAt).not.toBeNull();
  expect(names((await stack.api(ana.jar, "GET", `/nodes?parent=${docs.id}`)).body)).toEqual([
    "Inner",
    "b.txt",
  ]);
  expect(names((await stack.api(ana.jar, "GET", "/trash")).body)).toEqual(["a.txt"]);
  expect(await stack.usedBytes(org.id)).toBe(6);
  const restored = await stack.api(ana.jar, "POST", `/nodes/${a.id}/restore`);
  expect(restored.body.node).toMatchObject({ parentId: docs.id, trashedAt: null });
  expect(Buffer.from(await (await stack.download(ana.jar, a.id)).arrayBuffer()).toString()).toBe(
    "aaaa",
  );

  await stack.api(ana.jar, "DELETE", `/nodes/${docs.id}`);
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${docs.id}?forever=1`)).status).toBe(204);
  expect(await bucket.head(key)).toBeNull();
  expect((await bucket.list({ prefix: `orgs/${org.id}/` })).objects).toEqual([]);
  expect(await stack.usedBytes(org.id)).toBe(0);
  expect(names((await stack.api(ana.jar, "GET", "/trash")).body)).toEqual([]);
  expect((await stack.download(ana.jar, a.id)).status).toBe(404);
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${docs.id}?forever=1`)).status).toBe(404);
});

test("the minute cron aborts an upload nobody completed in 24 hours, and only that one", async () => {
  const org = await stack.company("expired-upload");
  const ana = await stack.member(org.id);
  const open = async (name: string) =>
    (await stack.api(ana.jar, "POST", "/uploads", { name, size: 10, space: "personal" })).body
      .upload as StorageUpload;
  const stale = await open("stale.bin");
  const fresh = await open("fresh.bin");
  expect((await stack.putPart(ana.jar, stale.id, 1, randomBytes(10))).status).toBe(200);
  expect((await stack.api(ana.jar, "GET", "/usage")).body.reservedBytes).toBe(20);
  await stack.db
    .update(schema.storageUploads)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.storageUploads.id, stale.id));

  const [row] = await stack.db
    .select()
    .from(schema.storageUploads)
    .where(eq(schema.storageUploads.id, stale.id));
  const inBucket = (await stack.bucket()).resumeMultipartUpload(row!.r2Key, row!.r2UploadId!);
  await expect(inBucket.uploadPart(2, "probe")).resolves.toBeDefined();

  expect((await stack.api(ana.jar, "POST", `/uploads/${stale.id}/complete`)).status).toBe(404);
  for (let run = 0; run < 2; run++) expect(await stack.cron("* * * * *")).toBe("ok");

  const rows = await stack.db
    .select({ id: schema.storageUploads.id })
    .from(schema.storageUploads)
    .where(eq(schema.storageUploads.orgId, org.id));
  expect(rows).toEqual([{ id: fresh.id }]);
  expect((await stack.api(ana.jar, "GET", `/uploads/${stale.id}`)).status).toBe(404);
  expect((await stack.putPart(ana.jar, stale.id, 1, randomBytes(10))).status).toBe(404);
  await expect(inBucket.uploadPart(2, "probe")).rejects.toThrow("does not exist");
  expect((await stack.api(ana.jar, "GET", "/usage")).body.reservedBytes).toBe(10);
  expect((await (await stack.bucket()).list({ prefix: `orgs/${org.id}/` })).objects).toEqual([]);

  expect((await stack.putPart(ana.jar, fresh.id, 1, randomBytes(10))).status).toBe(200);
  expect((await stack.api(ana.jar, "POST", `/uploads/${fresh.id}/complete`)).status).toBe(200);
  const dropped = await open("dropped.bin");
  expect((await stack.api(ana.jar, "DELETE", `/uploads/${dropped.id}`)).status).toBe(204);
  expect((await stack.api(ana.jar, "POST", `/uploads/${dropped.id}/complete`)).status).toBe(404);
  expect((await stack.api(ana.jar, "GET", "/usage")).body.reservedBytes).toBe(0);
});

test("an expired upload the cron cannot remove does not hold up the others, and the run fails", async () => {
  const org = await stack.company("stuck-upload");
  const ana = await stack.member(org.id);
  const open = async (name: string) =>
    (await stack.api(ana.jar, "POST", "/uploads", { name, size: 10, space: "personal" })).body
      .upload as StorageUpload;
  const stuck = await open("stuck.bin");
  const other = await open("other.bin");
  for (const [upload, ago] of [
    [stuck, 120_000],
    [other, 60_000],
  ] as const) {
    await stack.db
      .update(schema.storageUploads)
      .set({ expiresAt: new Date(Date.now() - ago) })
      .where(eq(schema.storageUploads.id, upload.id));
  }
  await stack.db.execute(
    sql.raw(`
      create function e2e_refuse_delete() returns trigger language plpgsql as
        $$ begin raise exception 'e2e: this upload cannot be removed'; end $$;
      create trigger e2e_refuse_delete before delete on storage_uploads for each row
        when (old.id = '${stuck.id}') execute function e2e_refuse_delete();
    `),
  );
  const left = async () =>
    (
      await stack.db
        .select({ id: schema.storageUploads.id })
        .from(schema.storageUploads)
        .where(eq(schema.storageUploads.orgId, org.id))
    ).map((row) => row.id);
  try {
    expect(await stack.cron("* * * * *")).toBe("exception");
    expect(await left()).toEqual([stuck.id]);
  } finally {
    await stack.db.execute(
      sql.raw(`
        drop trigger e2e_refuse_delete on storage_uploads;
        drop function e2e_refuse_delete();
      `),
    );
  }
  expect(await stack.cron("* * * * *")).toBe("ok");
  expect(await left()).toEqual([]);
});

test("the daily cron purges Trash after 30 days, recounts usage, and sweeps only deleted workspaces from the bucket", async () => {
  const bucket = await stack.bucket();
  const org = await stack.company("daily");
  const ana = await stack.member(org.id);
  const old = await stack.upload(ana.jar, { space: "personal" }, "old.bin", randomBytes(100));
  const recent = await stack.upload(ana.jar, { space: "personal" }, "recent.bin", randomBytes(30));
  const kept = await stack.upload(ana.jar, { space: "shared" }, "kept.bin", randomBytes(7));
  for (const node of [old, recent]) await stack.api(ana.jar, "DELETE", `/nodes/${node.id}`);
  await stack.db
    .update(schema.storageNodes)
    .set({ trashedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
    .where(eq(schema.storageNodes.id, old.id));
  await stack.db
    .update(schema.storageUsage)
    .set({ bytes: 5 })
    .where(eq(schema.storageUsage.orgId, org.id));

  const gone = await stack.company("closed");
  const cy = await stack.member(gone.id);
  const lost = await stack.upload(cy.jar, { space: "shared" }, "lost.bin", randomBytes(9));
  const closed = [{ org: gone, file: lost }];
  for (const id of [`0-first-${randomUUID()}`, `~last-${randomUUID()}`]) {
    const [org] = await stack.db
      .insert(schema.organizations)
      .values({ id, name: id, slug: id, createdAt: new Date() })
      .returning();
    const dee = await stack.member(org!.id);
    const file = await stack.upload(dee.jar, { space: "shared" }, "lost.bin", randomBytes(9));
    closed.push({ org: org!, file });
  }
  for (const { org: shut, file } of closed) {
    await stack.db.delete(schema.organizations).where(eq(schema.organizations.id, shut.id));
    expect(await bucket.head(storageObjectKey(shut.id, file.id))).not.toBeNull();
  }
  await bucket.put(`other/${randomUUID()}`, "x");

  for (let run = 0; run < 2; run++) expect(await stack.cron("47 3 * * *")).toBe("ok");

  expect(await bucket.head(storageObjectKey(org.id, old.id))).toBeNull();
  expect(await bucket.head(storageObjectKey(org.id, recent.id))).not.toBeNull();
  expect(await bucket.head(storageObjectKey(org.id, kept.id))).not.toBeNull();
  expect(names((await stack.api(ana.jar, "GET", "/trash")).body)).toEqual(["recent.bin"]);
  expect(await stack.usedBytes(org.id)).toBe(37);
  expect((await stack.download(ana.jar, kept.id)).status).toBe(200);

  for (const { org: shut } of closed) {
    expect((await bucket.list({ prefix: `orgs/${shut.id}/` })).objects).toEqual([]);
  }
  expect((await bucket.list({ prefix: "other/" })).objects).toHaveLength(1);
});

test("removing a member hands their My files to the admin who removed them; leaving hands them to the owner", async () => {
  const org = await stack.company("leavers");
  const owner = await stack.member(org.id, "owner");
  const admin = await stack.member(org.id, "admin");
  const ben = await stack.member(org.id);
  const cy = await stack.member(org.id);
  const contract = Buffer.from("the signed contract");

  const deals = (await stack.api(ben.jar, "POST", "/folders", { name: "Deals", space: "personal" }))
    .body.node as StorageNode;
  const file = await stack.upload(ben.jar, { parentId: deals.id }, "contract.pdf", contract);
  const open = await stack.api(ben.jar, "POST", "/uploads", {
    name: "half.bin",
    size: 5,
    space: "personal",
  });
  expect(open.status).toBe(201);
  expect((await stack.download(admin.jar, file.id)).status).toBe(404);

  const removed = await authPost(stack.worker, admin.jar, "/organization/remove-member", {
    memberIdOrEmail: ben.email,
  });
  expect(removed.status).toBe(200);
  expect(await stack.db.select().from(schema.members).where(eq(schema.members.id, ben.id))).toEqual(
    [],
  );

  const root = await stack.api(admin.jar, "GET", "/nodes?space=personal");
  expect(names(root.body)).toEqual([`Files from ${ben.email}`]);
  const handed = await stack.api(admin.jar, "GET", `/nodes?parent=${root.body.nodes[0].id}`);
  expect(names(handed.body)).toEqual(["Deals"]);
  expect(names((await stack.api(admin.jar, "GET", `/nodes?parent=${deals.id}`)).body)).toEqual([
    "contract.pdf",
  ]);
  const download = await stack.download(admin.jar, file.id);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(contract);
  expect((await stack.download(owner.jar, file.id)).status).toBe(404);
  expect((await stack.download(ben.jar, file.id)).status).toBe(403);
  expect(await stack.usedBytes(org.id)).toBe(contract.length);

  const notes = await stack.upload(cy.jar, { space: "personal" }, "notes.txt", Buffer.from("cy"));
  const left = await authPost(stack.worker, cy.jar, "/organization/leave", {
    organizationId: org.id,
  });
  expect(left.status).toBe(200);
  expect(names((await stack.api(owner.jar, "GET", "/nodes?space=personal")).body)).toEqual([
    `Files from ${cy.email}`,
  ]);
  expect((await stack.download(owner.jar, notes.id)).status).toBe(200);
  expect((await stack.download(admin.jar, notes.id)).status).toBe(404);

  const stay = await authPost(stack.worker, owner.jar, "/organization/leave", {
    organizationId: org.id,
  });
  expect(stay.status).toBe(400);
  expect((await stack.api(owner.jar, "GET", "/nodes?space=personal")).body.nodes).toHaveLength(1);
});

test("deleting a workspace through its endpoint works when its members have files, and the sweep then empties its prefix", async () => {
  const bucket = await stack.bucket();
  const org = await stack.company("closing");
  const owner = await stack.member(org.id, "owner");
  const ben = await stack.member(org.id);
  const mine = await stack.upload(ben.jar, { space: "personal" }, "mine.txt", Buffer.from("ben"));
  const ours = await stack.upload(owner.jar, { space: "shared" }, "ours.txt", Buffer.from("all"));
  const open = await stack.api(ben.jar, "POST", "/uploads", {
    name: "half.bin",
    size: 5,
    space: "personal",
  });
  expect(open.status).toBe(201);

  const deleted = await authPost(stack.worker, owner.jar, "/organization/delete", {
    organizationId: org.id,
  });
  expect(deleted.status).toBe(200);
  expect(
    await stack.db.select().from(schema.organizations).where(eq(schema.organizations.id, org.id)),
  ).toEqual([]);
  for (const table of [schema.storageNodes, schema.storageUploads, schema.storageUsage]) {
    expect(await stack.db.select().from(table).where(eq(table.orgId, org.id))).toEqual([]);
  }
  expect(await bucket.head(storageObjectKey(org.id, mine.id))).not.toBeNull();
  expect(await bucket.head(storageObjectKey(org.id, ours.id))).not.toBeNull();
  expect(await stack.cron("47 3 * * *")).toBe("ok");
  expect((await bucket.list({ prefix: `orgs/${org.id}/` })).objects).toEqual([]);
});

test("an expired upload whose object was already stitched leaves nothing in the bucket, and files keep theirs", async () => {
  const org = await stack.company("stitched");
  const ana = await stack.member(org.id);
  const bucket = await stack.bucket();
  const kept = await stack.upload(ana.jar, { space: "personal" }, "kept.bin", randomBytes(20));
  const opened = await stack.api(ana.jar, "POST", "/uploads", {
    name: "lost.bin",
    size: 10,
    space: "personal",
  });
  const upload = opened.body.upload as StorageUpload;
  expect((await stack.putPart(ana.jar, upload.id, 1, randomBytes(10))).status).toBe(200);
  const [row] = await stack.db
    .select()
    .from(schema.storageUploads)
    .where(eq(schema.storageUploads.id, upload.id));
  await bucket
    .resumeMultipartUpload(row!.r2Key, row!.r2UploadId!)
    .complete(row!.parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
  expect(await bucket.head(row!.r2Key)).not.toBeNull();
  await stack.db
    .update(schema.storageUploads)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.storageUploads.orgId, org.id));

  for (let run = 0; run < 2; run++) expect(await stack.cron("* * * * *")).toBe("ok");

  expect(
    await stack.db
      .select()
      .from(schema.storageUploads)
      .where(eq(schema.storageUploads.orgId, org.id)),
  ).toEqual([]);
  expect((await bucket.list({ prefix: `orgs/${org.id}/` })).objects.map((o) => o.key)).toEqual([
    storageObjectKey(org.id, kept.id),
  ]);
  expect((await stack.download(ana.jar, kept.id)).status).toBe(200);
});

test("a move too deep or into itself, and a restore under a trashed folder, answer their own 409 codes", async () => {
  const org = await stack.company("codes");
  const ana = await stack.member(org.id);
  const folder = async (name: string, place: object) => {
    const made = await stack.api(ana.jar, "POST", "/folders", { name, ...place });
    expect(made.status).toBe(201);
    return made.body.node as StorageNode;
  };
  let deepest = await folder("d1", { space: "personal" });
  const top = deepest;
  for (let depth = 2; depth <= 32; depth++) {
    deepest = await folder(`d${depth}`, { parentId: deepest.id });
  }
  const deeper = await stack.api(ana.jar, "POST", "/folders", {
    name: "d33",
    parentId: deepest.id,
  });
  expect(deeper).toMatchObject({ status: 409, body: { code: "TOO_DEEP" } });
  const other = await folder("other", { space: "personal" });
  expect(
    await stack.api(ana.jar, "PATCH", `/nodes/${other.id}`, { parentId: deepest.id }),
  ).toMatchObject({ status: 409, body: { code: "TOO_DEEP" } });
  expect(
    await stack.api(ana.jar, "PATCH", `/nodes/${top.id}`, { parentId: deepest.id }),
  ).toMatchObject({ status: 409, body: { code: "CYCLE" } });

  const child = await folder("child", { parentId: other.id });
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${child.id}`)).status).toBe(200);
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${other.id}`)).status).toBe(200);
  expect(await stack.api(ana.jar, "POST", `/nodes/${child.id}/restore`)).toMatchObject({
    status: 409,
    body: { code: "PARENT_TRASHED" },
  });
});

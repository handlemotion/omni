import { randomUUID } from "node:crypto";
import type { StorageNode, StorageUpload, StorageVersionsResponse } from "@omni/contracts";
import { forMember, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { CookieJar, signIn } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const bytes = (text: string) => new TextEncoder().encode(text);

async function sendVersion(jar: CookieJar, nodeId: string, text: string, base = "") {
  const body = bytes(text);
  const opened = await stack.api(jar, "POST", `${base}/files/${nodeId}/versions`, {
    size: body.length,
    mimeType: "text/markdown",
  });
  if (opened.status !== 201) return opened;
  const upload = opened.body.upload as StorageUpload;
  const sent = await stack.putPart(jar, upload.id, 1, body, base);
  if (sent.status !== 200) throw new Error(`part: ${sent.status}`);
  await sent.body?.cancel();
  return { status: 201, body: opened.body, uploadId: upload.id };
}

async function saveVersion(jar: CookieJar, nodeId: string, text: string, base = "") {
  const sent = await sendVersion(jar, nodeId, text, base);
  if (!("uploadId" in sent)) return sent;
  return stack.api(jar, "POST", `${base}/uploads/${sent.uploadId}/complete`);
}

const text = async (response: Response) => [response.status, await response.text()];
const objectCount = async (orgId: string) =>
  (await (await stack.bucket()).list({ prefix: `orgs/${orgId}/` })).objects.length;

test("each version downloads its own bytes, a restore swaps them, and deleting the file empties the bucket", async () => {
  const org = await stack.company(`versions-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "plan.md", bytes("first"));

  const saved = await saveVersion(ana.jar, file.id, "second, longer");
  expect(saved.status).toBe(200);
  expect(saved.body.node as StorageNode).toMatchObject({
    id: file.id,
    name: "plan.md",
    size: 14,
    mimeType: "text/markdown",
  });
  expect(await text(await stack.download(ana.jar, file.id))).toEqual([200, "second, longer"]);
  expect(await stack.usedBytes(org.id)).toBe(19);

  const listed = await stack.api(ana.jar, "GET", `/files/${file.id}/versions`);
  expect(listed.status).toBe(200);
  const { current, versions, keepDays } = listed.body as StorageVersionsResponse;
  expect(keepDays).toBe(30);
  expect(current).toMatchObject({ size: 14, writtenByName: ana.email });
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({ size: 5, mimeType: null, writtenAt: file.createdAt });
  const old = `/files/${file.id}/versions/${versions[0]!.id}`;
  const kept = await stack.get(ana.jar, `${old}/content`);
  expect(kept.headers.get("content-disposition")).toContain('filename="plan.md"');
  expect(await text(kept)).toEqual([200, "first"]);

  const restored = await stack.api(ana.jar, "POST", `${old}/restore`);
  expect([restored.status, restored.body.node.size]).toEqual([200, 5]);
  expect(await text(await stack.download(ana.jar, file.id))).toEqual([200, "first"]);
  const after = (await stack.api(ana.jar, "GET", `/files/${file.id}/versions`))
    .body as StorageVersionsResponse;
  expect(after.versions.map((version) => version.size)).toEqual([14]);
  expect(await stack.usedBytes(org.id)).toBe(19);
  expect(await objectCount(org.id)).toBe(2);

  await stack.api(ana.jar, "DELETE", `/nodes/${file.id}`);
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${file.id}?forever=1`)).status).toBe(204);
  expect(await objectCount(org.id)).toBe(0);
  expect(await stack.usedBytes(org.id)).toBe(0);
});

test("under a link an Editor saves and restores versions; a Viewer and an anonymous reader get none of it", async () => {
  const org = await stack.company(`versions-shared-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "brief.md", bytes("v1"));
  await saveVersion(ana.jar, file.id, "v2 by ana");

  const grant = async (role: "viewer" | "editor") => {
    const email = `${role}-${randomUUID().slice(0, 8)}@outside.test`;
    const shared = await stack.api(
      ana.jar,
      "PUT",
      `/nodes/${file.id}/sharing/people/${encodeURIComponent(email)}`,
      { role },
    );
    const jar = new CookieJar();
    await signIn(stack.worker, stack.db, email, jar);
    return { jar, base: `/shared/${shared.body.sharing.shareId as string}` };
  };
  const viewer = await grant("viewer");
  const editor = await grant("editor");
  const { versions } = (await stack.api(ana.jar, "GET", `/files/${file.id}/versions`))
    .body as StorageVersionsResponse;
  const old = `/files/${file.id}/versions/${versions[0]!.id}`;

  expect(
    await text(await stack.get(viewer.jar, `${viewer.base}/files/${file.id}/content`)),
  ).toEqual([200, "v2 by ana"]);
  const refusals = [
    await stack.api(viewer.jar, "GET", `${viewer.base}/files/${file.id}/versions`),
    await stack.api(viewer.jar, "GET", `${viewer.base}${old}/content`),
    await stack.api(viewer.jar, "POST", `${viewer.base}${old}/restore`),
    await saveVersion(viewer.jar, file.id, "viewer was here", viewer.base),
  ].map((answer) => answer.status);
  expect(refusals).toEqual([403, 404, 403, 403]);

  await stack.api(ana.jar, "PUT", `/nodes/${file.id}/sharing/link`, { linkAccess: "anyone" });
  const anonymous = new CookieJar();
  expect(
    (await stack.api(anonymous, "GET", `${viewer.base}/files/${file.id}/versions`)).status,
  ).toBe(403);
  expect((await stack.get(anonymous, `${viewer.base}${old}/content`)).status).toBe(403);

  expect((await saveVersion(editor.jar, file.id, "v3 by editor", editor.base)).status).toBe(200);
  expect(await text(await stack.get(editor.jar, `${editor.base}${old}/content`))).toEqual([
    200,
    "v1",
  ]);
  expect((await stack.api(editor.jar, "POST", `${editor.base}${old}/restore`)).status).toBe(200);
  expect(await text(await stack.download(ana.jar, file.id))).toEqual([200, "v1"]);
});

test("a locked file answers 409 locked to a new version and a restore, and the refused bytes leave the bucket", async () => {
  const org = await stack.company(`versions-locked-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "shared" }, "contract.md", bytes("draft"));
  await saveVersion(ana.jar, file.id, "signed");
  const pending = await sendVersion(ana.jar, file.id, "after signing");
  if (!("uploadId" in pending)) throw new Error(`open: ${pending.status}`);
  const locked = await forMember(stack.db, ana.id).storage.lock(file.id);
  expect(locked.status).toBe("ok");

  const late = await stack.api(ana.jar, "POST", `/uploads/${pending.uploadId}/complete`);
  expect([late.status, late.body.code]).toEqual([409, "LOCKED"]);
  const opened = await sendVersion(ana.jar, file.id, "again");
  expect([opened.status, opened.body.code]).toEqual([409, "LOCKED"]);
  const { versions } = (await stack.api(ana.jar, "GET", `/files/${file.id}/versions`))
    .body as StorageVersionsResponse;
  const restore = await stack.api(
    ana.jar,
    "POST",
    `/files/${file.id}/versions/${versions[0]!.id}/restore`,
  );
  expect([restore.status, restore.body.code]).toEqual([409, "LOCKED"]);

  expect(await text(await stack.download(ana.jar, file.id))).toEqual([200, "signed"]);
  expect(await objectCount(org.id)).toBe(2);
  expect(await stack.usedBytes(org.id)).toBe(11);
});

test("the daily job deletes versions replaced more than 30 days ago, rows and objects, and no others", async () => {
  const org = await stack.company(`versions-purge-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "log.md", bytes("one"));
  await saveVersion(ana.jar, file.id, "two!");
  await saveVersion(ana.jar, file.id, "three");
  const rows = await stack.db
    .select()
    .from(schema.storageVersions)
    .where(eq(schema.storageVersions.nodeId, file.id));
  const oldest = rows.find((row) => row.size === 3)!;
  await stack.db
    .update(schema.storageVersions)
    .set({ replacedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) })
    .where(eq(schema.storageVersions.id, oldest.id));

  expect(await stack.cron("47 3 * * *")).toBe("ok");

  const { versions } = (await stack.api(ana.jar, "GET", `/files/${file.id}/versions`))
    .body as StorageVersionsResponse;
  expect(versions.map((version) => version.size)).toEqual([4]);
  expect(await (await stack.bucket()).head(oldest.r2Key)).toBeNull();
  expect(await objectCount(org.id)).toBe(2);
  expect(await stack.usedBytes(org.id)).toBe(9);
  expect(await text(await stack.download(ana.jar, file.id))).toEqual([200, "three"]);
});

test("a checked save on stale content answers 409 with the file's content version, and stores nothing", async () => {
  const org = await stack.company(`versions-checked-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "shared" }, "doc.md", bytes("one"));
  expect(file.contentVersion).toBe(1);

  async function open(content: string, base: number) {
    const body = bytes(content);
    const opened = await stack.api(ana.jar, "POST", `/files/${file.id}/versions`, {
      size: body.length,
      ifContentVersion: base,
    });
    if (opened.status !== 201) return { opened, complete: "" };
    const uploadId = opened.body.upload.id as string;
    const sent = await stack.putPart(ana.jar, uploadId, 1, body);
    await sent.body?.cancel();
    return { opened, complete: `/uploads/${uploadId}/complete?ifContentVersion=${base}` };
  }

  const mine = await open("mine", 1);
  const theirs = await open("theirs, saved first", 1);
  const saved = await stack.api(ana.jar, "POST", theirs.complete);
  expect([saved.status, saved.body.node.contentVersion]).toEqual([200, 2]);

  const late = await stack.api(ana.jar, "POST", mine.complete);
  expect([late.status, late.body.code, late.body.details]).toEqual([
    409,
    "VERSION_CONFLICT",
    { contentVersion: 2 },
  ]);
  const stale = await open("mine again", 1);
  expect([stale.opened.status, stale.opened.body.details]).toEqual([409, { contentVersion: 2 }]);
  expect(await text(await stack.download(ana.jar, file.id))).toEqual([200, "theirs, saved first"]);
  expect(await objectCount(org.id)).toBe(2);

  const merged = await open("theirs and mine", 2);
  const done = await stack.api(ana.jar, "POST", merged.complete);
  expect([done.status, done.body.node.contentVersion]).toEqual([200, 3]);
});

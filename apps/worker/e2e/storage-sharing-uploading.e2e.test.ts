import { randomBytes, randomUUID } from "node:crypto";
import type { StorageNode, StorageUpload } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_STORAGE_LINK: "off" },
  });
});
afterAll(() => stack?.stop());

const anonymous = () => new CookieJar();

async function company() {
  const org = await stack.company(`uploading-${randomUUID().slice(0, 8)}`);
  return { org, owner: await stack.member(org.id, "owner") };
}

async function opened(person: Person, place: object, name: string, bytes: Uint8Array) {
  const open = await stack.api(person.jar, "POST", "/uploads", {
    name,
    size: bytes.length,
    ...place,
  });
  if (open.status !== 201) throw new Error(`open ${name}: ${open.status}`);
  const upload = open.body.upload as StorageUpload;
  return {
    upload,
    async send() {
      const sent = await stack.putPart(person.jar, upload.id, 1, bytes);
      expect(sent.status).toBe(200);
      await sent.body?.cancel();
    },
    async complete() {
      const done = await stack.api(person.jar, "POST", `/uploads/${upload.id}/complete`);
      expect(done.status).toBe(200);
      return done.body.node as StorageNode;
    },
  };
}

const uploadLink = (person: Person, uploadId: string, body: object) =>
  stack.api(person.jar, "PUT", `/uploads/${uploadId}/sharing/link`, body);

const content = (jar: CookieJar, shareId: string, nodeId: string, headers = {}) =>
  stack.get(jar, `/shared/${shareId}/files/${nodeId}/content`, headers);

async function status(response: Response) {
  await response.body?.cancel();
  return response.status;
}

test("a link made while a file uploads shows its progress, refuses its bytes, and is the file's link once it completes", async () => {
  const { owner } = await company();
  const bytes = randomBytes(4000);
  const file = await opened(owner, { space: "personal" }, "cut.mov", bytes);
  const made = await uploadLink(owner, file.upload.id, { linkAccess: "anyone" });
  expect(made.body.sharing).toMatchObject({ nodeId: file.upload.id, linkAccess: "anyone" });
  const shareId = made.body.sharing.shareId as string;

  const early = await stack.api(anonymous(), "GET", `/shared/${shareId}`);
  expect(early.body).toMatchObject({
    item: { node: { id: file.upload.id, kind: "file", name: "cut.mov", orgId: "" } },
    uploading: [{ id: file.upload.id, size: 4000, uploadedBytes: 0 }],
  });
  expect(await status(await content(anonymous(), shareId, file.upload.id))).toBe(404);
  expect(await status(await stack.get(anonymous(), `/shared/${shareId}/zip`))).toBe(404);

  await file.send();
  const progress = await stack.api(anonymous(), "GET", `/shared/${shareId}/uploading`);
  expect(progress.body.uploading).toMatchObject([{ id: file.upload.id, uploadedBytes: 4000 }]);

  const node = await file.complete();
  expect(node.id).toBe(file.upload.id);
  const done = await stack.api(anonymous(), "GET", `/shared/${shareId}`);
  expect(done.body.item.node.id).toBe(file.upload.id);
  expect(done.body.uploading).toEqual([]);
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}/uploading`)).body).toEqual({
    uploading: [],
  });
  const got = await content(anonymous(), shareId, node.id);
  expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);
  const sharing = await stack.api(owner.jar, "GET", `/nodes/${node.id}/sharing`);
  expect(sharing.body.sharing).toMatchObject({ shareId, linkAccess: "anyone" });

  const history = await stack.db
    .select({ kind: schema.storageShareEvents.kind })
    .from(schema.storageShareEvents)
    .where(eq(schema.storageShareEvents.nodeId, node.id));
  expect(history.map((event) => event.kind)).toEqual(
    expect.arrayContaining(["link_changed", "viewed", "downloaded"]),
  );
});

test("an uploading file's link keeps its password and view-only setting through completion, and its unlock key keeps working", async () => {
  const { owner } = await company();
  const bytes = randomBytes(3000);
  const file = await opened(owner, { space: "personal" }, "draft.pdf", bytes);
  const id = file.upload.id;
  const locked = await uploadLink(owner, id, { password: "open sesame" });
  const shareId = locked.body.sharing.shareId as string;
  expect(locked.body.sharing).toMatchObject({
    linkAccess: "restricted",
    link: { hasPassword: true },
  });
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await stack.api(owner.jar, "GET", `/shared/${shareId}`)).status).toBe(200);

  await uploadLink(owner, id, { linkAccess: "anyone" });
  await uploadLink(owner, id, { downloads: false });
  const visitor = anonymous();
  expect(await stack.api(visitor, "GET", `/shared/${shareId}`)).toMatchObject({
    status: 401,
    body: { code: "LINK_LOCKED" },
  });
  const wrong = await stack.api(visitor, "POST", `/shared/${shareId}/unlock`, { password: "no" });
  expect(wrong.status).toBe(403);
  const right = await stack.api(visitor, "POST", `/shared/${shareId}/unlock`, {
    password: "open sesame",
  });
  const keyed = { "x-omni-link-key": right.body.key as string };
  const seen = await stack.get(anonymous(), `/shared/${shareId}`, keyed);
  expect(await seen.json()).toMatchObject({ downloads: false, uploading: [{ id }] });

  await file.send();
  await file.complete();
  expect(await status(await content(anonymous(), shareId, id))).toBe(401);
  expect(await status(await content(anonymous(), shareId, id, keyed))).toBe(403);
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(401);
  expect(await status(await stack.get(anonymous(), `/shared/${shareId}`, keyed))).toBe(200);
  const sharing = await stack.api(owner.jar, "GET", `/nodes/${id}/sharing`);
  expect(sharing.body.sharing.link).toMatchObject({ hasPassword: true, downloads: false });
});

test("the workspace policy refuses an Anyone link on an upload; Workspace opens for colleagues only; expiry closes it", async () => {
  const { org, owner } = await company();
  const colleague = await stack.member(org.id, "member");
  const outsider = (await company()).owner;
  const file = await opened(owner, { space: "personal" }, "plan.key", randomBytes(2000));
  const id = file.upload.id;
  await stack.api(owner.jar, "PUT", "/policy", { publicLinks: false });
  expect(await uploadLink(owner, id, { linkAccess: "anyone" })).toMatchObject({
    status: 403,
    body: { code: "SHARING_POLICY" },
  });
  const set = await uploadLink(owner, id, { linkAccess: "workspace" });
  const shareId = set.body.sharing.shareId as string;
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await stack.api(outsider.jar, "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await stack.api(colleague.jar, "GET", `/shared/${shareId}`)).status).toBe(200);

  await uploadLink(owner, id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  expect((await stack.api(colleague.jar, "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await stack.api(owner.jar, "GET", `/shared/${shareId}`)).status).toBe(200);
});

test("a folder's link lists the new files uploading into it with their progress, and lists them as files once complete", async () => {
  const { owner } = await company();
  const made = await stack.api(owner.jar, "POST", "/folders", { name: "Shoot", space: "personal" });
  const folder = made.body.node as StorageNode;
  const other = (
    await stack.api(owner.jar, "POST", "/folders", { name: "Else", space: "personal" })
  ).body.node as StorageNode;
  const shareId = (
    await stack.api(owner.jar, "PUT", `/nodes/${folder.id}/sharing/link`, { linkAccess: "anyone" })
  ).body.sharing.shareId as string;
  const kept = await stack.upload(owner.jar, { parentId: folder.id }, "kept.txt", randomBytes(10));
  const version = await stack.api(owner.jar, "POST", `/files/${kept.id}/versions`, { size: 20 });
  expect(version.status).toBe(201);
  const elsewhere = await opened(owner, { parentId: other.id }, "elsewhere.bin", randomBytes(5));
  const bytes = randomBytes(6000);
  const file = await opened(owner, { parentId: folder.id }, "a-roll.mp4", bytes);

  const listed = await stack.api(anonymous(), "GET", `/shared/${shareId}`);
  expect(listed.body.nodes.map((node: StorageNode) => node.name)).toEqual(["kept.txt"]);
  expect(listed.body.uploading).toMatchObject([
    { id: file.upload.id, name: "a-roll.mp4", size: 6000, uploadedBytes: 0 },
  ]);
  expect(JSON.stringify(listed.body)).not.toContain(elsewhere.upload.id);

  await file.send();
  const progress = await stack.api(anonymous(), "GET", `/shared/${shareId}/uploading`);
  expect(progress.body.uploading).toMatchObject([{ id: file.upload.id, uploadedBytes: 6000 }]);
  await file.complete();
  const after = await stack.api(anonymous(), "GET", `/shared/${shareId}`);
  expect(after.body.uploading).toEqual([]);
  expect(after.body.nodes.map((node: StorageNode) => node.name)).toEqual([
    "a-roll.mp4",
    "kept.txt",
  ]);
});

test("only the uploader shares an upload; cancelling it closes the link; after completion the upload's routes share the file", async () => {
  const { org, owner } = await company();
  const colleague = await stack.member(org.id, "member");
  const file = await opened(owner, { space: "shared" }, "board.psd", randomBytes(1000));
  expect((await stack.api(colleague.jar, "GET", `/uploads/${file.upload.id}/sharing`)).status).toBe(
    404,
  );
  expect((await uploadLink(colleague, file.upload.id, { linkAccess: "anyone" })).status).toBe(404);
  const shareId = (await uploadLink(owner, file.upload.id, { linkAccess: "restricted" })).body
    .sharing.shareId as string;
  expect((await stack.api(colleague.jar, "GET", `/shared/${shareId}`)).status).toBe(200);
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await stack.api(owner.jar, "DELETE", `/uploads/${file.upload.id}`)).status).toBe(204);
  expect((await stack.api(owner.jar, "GET", `/shared/${shareId}`)).status).toBe(404);

  const next = await opened(owner, { space: "personal" }, "next.psd", randomBytes(1000));
  await next.send();
  await next.complete();
  const late = await uploadLink(owner, next.upload.id, { linkAccess: "anyone" });
  expect(late.body.sharing).toMatchObject({ nodeId: next.upload.id, linkAccess: "anyone" });
  const opens = await stack.api(anonymous(), "GET", `/shared/${late.body.sharing.shareId}`);
  expect(opens.body.item.node.id).toBe(next.upload.id);
});

import { randomBytes, randomUUID } from "node:crypto";
import type { StorageNode } from "@omni/contracts";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { DOC_TYPE } from "@omni/docs/file";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, sentMail, signIn, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_STORAGE_LINK: "off",
      RATE_LIMIT_STORAGE_LINK_PASSWORD: "3/900",
      RATE_LIMIT_STORAGE_SHARE_NEW: "2/86400",
    },
  });
});
afterAll(() => stack?.stop());

const anonymous = () => new CookieJar();
const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@outside.test`;
const person = (nodeId: string, email: string) =>
  `/nodes/${nodeId}/sharing/people/${encodeURIComponent(email)}`;

async function company() {
  const org = await stack.company(`links-${randomUUID().slice(0, 8)}`);
  return { org, owner: await stack.member(org.id, "owner") };
}

async function linked(owner: Person, linkAccess = "anyone", name = "brief.pdf") {
  const bytes = randomBytes(4000);
  const file = await stack.upload(owner.jar, { space: "personal" }, name, bytes);
  const set = await stack.api(owner.jar, "PUT", `/nodes/${file.id}/sharing/link`, { linkAccess });
  expect(set.status).toBe(200);
  return { file, bytes, shareId: set.body.sharing.shareId as string };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const settings = (owner: Person, nodeId: string, body: object) =>
  stack.api(owner.jar, "PUT", `/nodes/${nodeId}/sharing/link`, body);

const content = (jar: CookieJar, shareId: string, nodeId: string, headers = {}) =>
  stack.get(jar, `/shared/${shareId}/files/${nodeId}/content`, headers);

async function status(response: Response) {
  await response.body?.cancel();
  return response.status;
}

const events = (nodeId: string) =>
  stack.db
    .select()
    .from(schema.storageShareEvents)
    .where(eq(schema.storageShareEvents.nodeId, nodeId))
    .orderBy(schema.storageShareEvents.createdAt);

test("an expired link answers 404 to a visitor and keeps opening for the owner and for grants", async () => {
  const { owner } = await company();
  const { file, shareId } = await linked(owner);
  const guest = address("guest");
  expect(
    (await stack.api(owner.jar, "PUT", person(file.id, guest), { role: "viewer" })).status,
  ).toBe(200);
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(200);

  const past = new Date(Date.now() - 1000).toISOString();
  const expired = await settings(owner, file.id, { expiresAt: past });
  expect(expired.body.sharing).toMatchObject({ linkAccess: "anyone", link: { expiresAt: past } });
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  expect(await status(await content(anonymous(), shareId, file.id))).toBe(404);

  expect((await stack.api(owner.jar, "GET", `/shared/${shareId}`)).status).toBe(200);
  const guestJar = new CookieJar();
  await signIn(stack.worker, stack.db, guest, guestJar);
  expect(await status(await content(guestJar, shareId, file.id))).toBe(200);

  await settings(owner, file.id, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(200);
});

test("a password link stays locked until unlocked; wrong tries are refused, then rate-limited; a new password ends old keys", async () => {
  const { owner } = await company();
  const { file, bytes, shareId } = await linked(owner);
  const set = await settings(owner, file.id, { password: "open sesame" });
  expect(set.body.sharing.link).toMatchObject({ hasPassword: true });
  expect(JSON.stringify(set.body)).not.toContain("open sesame");
  const [stored] = await stack.db
    .select({ hash: schema.storageNodes.linkPasswordHash })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, file.id));
  expect(stored!.hash).not.toContain("open sesame");

  const visitor = anonymous();
  const locked = await stack.api(visitor, "GET", `/shared/${shareId}`);
  expect(locked).toMatchObject({ status: 401, body: { code: "LINK_LOCKED" } });
  expect(await status(await content(visitor, shareId, file.id))).toBe(401);
  expect((await stack.api(owner.jar, "GET", `/shared/${shareId}`)).status).toBe(200);

  const unlock = (jar: CookieJar, password: string) =>
    stack.api(jar, "POST", `/shared/${shareId}/unlock`, { password });
  expect(await unlock(visitor, "open sesam")).toMatchObject({
    status: 403,
    body: { code: "WRONG_PASSWORD" },
  });
  const right = await unlock(visitor, "open sesame");
  expect(right.status).toBe(200);
  const key = right.body.key as string;
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(401);
  const got = await content(anonymous(), shareId, file.id, { "x-omni-link-key": key });
  expect(got.status).toBe(200);
  expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);

  expect((await unlock(visitor, "nope")).status).toBe(403);
  const limited = await unlock(visitor, "open sesame");
  expect(limited).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });

  await settings(owner, file.id, { password: "new words" });
  const stale = await content(anonymous(), shareId, file.id, { "x-omni-link-key": key });
  expect(await status(stale)).toBe(401);
  await settings(owner, file.id, { password: null });
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(200);
});

test("a view-only link shows the item and refuses /content and /zip; the owner still downloads", async () => {
  const { owner } = await company();
  const { file, shareId } = await linked(owner);
  const off = await settings(owner, file.id, { downloads: false });
  expect(off.body.sharing.link).toMatchObject({ downloads: false });

  const seen = await stack.api(anonymous(), "GET", `/shared/${shareId}`);
  expect(seen.body).toMatchObject({ item: { node: { id: file.id } }, downloads: false });
  expect(await status(await content(anonymous(), shareId, file.id))).toBe(403);
  expect(await status(await content(anonymous(), shareId, file.id, { range: "bytes=0-9" }))).toBe(
    403,
  );
  expect(await status(await stack.get(anonymous(), `/shared/${shareId}/zip`))).toBe(403);
  const own = await content(owner.jar, shareId, file.id);
  expect(own.status).toBe(200);
  await own.body?.cancel();
});

test("/view serves what a link downloads, and on a view-only link only a doc and its images", async () => {
  const { owner } = await company();
  const markdown = "# Contrato\n\nCláusulas.";
  const doc = await stack.upload(
    owner.jar,
    { space: "personal" },
    "Contrato",
    new TextEncoder().encode(markdown),
    DOC_TYPE,
  );
  const set = await stack.api(owner.jar, "PUT", `/nodes/${doc.id}/sharing/link`, {
    linkAccess: "anyone",
  });
  const shareId = set.body.sharing.shareId as string;
  await settings(owner, doc.id, { downloads: false });

  expect(await status(await content(anonymous(), shareId, doc.id))).toBe(403);
  const text = await stack.get(anonymous(), `/shared/${shareId}/files/${doc.id}/view`);
  expect(text.status).toBe(200);
  expect(await text.text()).toBe(markdown);

  const pasted = await stack.upload(
    owner.jar,
    { parentId: doc.id },
    "pasted.png",
    PNG,
    "image/png",
  );
  const image = await stack.get(anonymous(), `/shared/${shareId}/files/${pasted.id}/view`);
  expect(image.status).toBe(200);
  expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(PNG));
  expect(await status(await content(anonymous(), shareId, pasted.id))).toBe(403);

  const { file, shareId: pdfShare } = await linked(owner);
  const allowed = await stack.get(anonymous(), `/shared/${pdfShare}/files/${file.id}/view`);
  expect(await status(allowed)).toBe(200);
  await settings(owner, file.id, { downloads: false });
  const refused = await stack.get(anonymous(), `/shared/${pdfShare}/files/${file.id}/view`);
  expect(await status(refused)).toBe(403);
});

test("a link open to the workspace opens for its members only, not for a visitor or another workspace", async () => {
  const { org, owner } = await company();
  const colleague = await stack.member(org.id, "member");
  const outsider = (await company()).owner;
  const { file, shareId } = await linked(owner, "workspace");

  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  expect(await status(await content(anonymous(), shareId, file.id))).toBe(404);
  expect((await stack.api(outsider.jar, "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await stack.download(colleague.jar, file.id)).status).toBe(404);
  const seen = await stack.api(colleague.jar, "GET", `/shared/${shareId}`);
  expect(seen.body.item).toMatchObject({ node: { id: file.id }, role: "viewer" });
  expect(await status(await content(colleague.jar, shareId, file.id))).toBe(200);
});

test("a link alone shows no workspace or member ids and no hash", async () => {
  const { owner } = await company();
  const { file, shareId } = await linked(owner);
  const seen = await stack.api(anonymous(), "GET", `/shared/${shareId}`);
  expect(seen.body.item.node).toMatchObject({
    orgId: "",
    ownerMemberId: null,
    createdByMemberId: null,
    contentSha256: null,
  });
  const raw = JSON.stringify(seen.body);
  for (const secret of [file.orgId, file.ownerMemberId!, file.createdByMemberId!]) {
    expect(raw).not.toContain(secret);
  }
  const own = await stack.api(owner.jar, "GET", `/shared/${shareId}`);
  expect(own.body.item.node.orgId).toBe(file.orgId);
});

test("the workspace policy closes and refuses public links and outside invites; only an admin sets it", async () => {
  const { org, owner } = await company();
  const colleague = await stack.member(org.id, "member");
  const { file, shareId } = await linked(owner);
  const folder = (await stack.api(owner.jar, "POST", "/folders", { name: "F", space: "personal" }))
    .body.node as StorageNode;

  expect((await stack.api(colleague.jar, "PUT", "/policy", { publicLinks: false })).status).toBe(
    403,
  );
  const set = await stack.api(owner.jar, "PUT", "/policy", {
    publicLinks: false,
    outsideSharing: false,
  });
  expect(set.body).toEqual({ policy: { publicLinks: false, outsideSharing: false } });
  expect((await stack.api(colleague.jar, "GET", "/policy")).body.policy.publicLinks).toBe(false);

  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  expect(await settings(owner, folder.id, { linkAccess: "anyone" })).toMatchObject({
    status: 403,
    body: { code: "SHARING_POLICY" },
  });
  expect((await settings(owner, folder.id, { linkAccess: "workspace" })).status).toBe(200);
  const outside = address("vendor");
  expect(
    await stack.api(owner.jar, "PUT", person(folder.id, outside), { role: "viewer" }),
  ).toMatchObject({ status: 403, body: { code: "SHARING_POLICY" } });
  expect(await sentMail(stack.worker, outside)).toEqual([]);
  expect(
    (await stack.api(owner.jar, "PUT", person(folder.id, colleague.email), { role: "viewer" }))
      .status,
  ).toBe(200);

  await stack.api(owner.jar, "PUT", "/policy", { publicLinks: true });
  expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(200);
  expect(file.id).toBeTruthy();
});

test("every view and download through a link writes one audit row; a resumed range does not", async () => {
  const { owner } = await company();
  const { file, shareId } = await linked(owner);
  const changes = await events(file.id);
  expect(changes.map((row) => [row.kind, row.via, row.detail])).toEqual([
    ["link_changed", "member", { linkAccess: "anyone" }],
  ]);

  const visitor = anonymous();
  expect((await stack.api(visitor, "GET", `/shared/${shareId}`)).status).toBe(200);
  expect(await status(await content(visitor, shareId, file.id))).toBe(200);
  expect(await status(await content(visitor, shareId, file.id, { range: "bytes=100-199" }))).toBe(
    206,
  );
  expect(await status(await content(owner.jar, shareId, file.id))).toBe(200);
  expect(await status(await stack.get(visitor, `/shared/${shareId}/zip`))).toBe(200);

  const after = (await events(file.id)).slice(1);
  expect(after.map((row) => [row.kind, row.via, row.actorUserId, row.detail.zip])).toEqual([
    ["viewed", "link", null, undefined],
    ["downloaded", "link", null, undefined],
    ["downloaded", "member", owner.userId, undefined],
    ["downloaded", "link", null, true],
  ]);
});

test("restoring from Trash does not reopen a link inside it; its grants stay", async () => {
  const { owner } = await company();
  const top = (await stack.api(owner.jar, "POST", "/folders", { name: "Top", space: "personal" }))
    .body.node as StorageNode;
  const inner = await stack.upload(owner.jar, { parentId: top.id }, "inner.txt", randomBytes(10));
  const topLink = (await settings(owner, top.id, { linkAccess: "anyone" })).body.sharing.shareId;
  const innerLink = (await settings(owner, inner.id, { linkAccess: "anyone" })).body.sharing
    .shareId;
  const guest = address("guest");
  await stack.api(owner.jar, "PUT", person(top.id, guest), { role: "viewer" });

  expect((await stack.api(owner.jar, "DELETE", `/nodes/${top.id}`)).status).toBe(200);
  expect((await stack.api(anonymous(), "GET", `/shared/${topLink}`)).status).toBe(404);
  expect((await stack.api(owner.jar, "POST", `/nodes/${top.id}/restore`)).status).toBe(200);

  for (const shareId of [topLink, innerLink]) {
    expect((await stack.api(anonymous(), "GET", `/shared/${shareId}`)).status).toBe(404);
  }
  const sharing = await stack.api(owner.jar, "GET", `/nodes/${top.id}/sharing`);
  expect(sharing.body.sharing).toMatchObject({
    shareId: topLink,
    linkAccess: "restricted",
    people: [{ email: guest }],
  });
  const rows = await stack.db
    .select({ access: schema.storageNodes.linkAccess })
    .from(schema.storageNodes)
    .where(and(eq(schema.storageNodes.id, inner.id)));
  expect(rows).toEqual([{ access: "restricted" }]);
});

test("a new account sends share mail under the tighter cap, its file name quoted and cut short", async () => {
  const { owner } = await company();
  const long = `${"Quarterly invoice ".repeat(6)}.pdf`;
  const { file } = await linked(owner, "restricted", long);
  const [one, two, three] = [address("one"), address("two"), address("three")];
  for (const email of [one, two]) {
    expect(
      (await stack.api(owner.jar, "PUT", person(file.id, email), { role: "viewer" })).status,
    ).toBe(200);
  }
  expect(
    await stack.api(owner.jar, "PUT", person(file.id, three), { role: "viewer" }),
  ).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
  const [mail] = await sentMail(stack.worker, one);
  expect(mail!.subject).not.toContain(long);
  expect(mail!.subject).toMatch(/shared "Quarterly invoice [^"]{0,30}…" with you/);

  const veteran = (await company()).owner;
  await stack.db
    .update(schema.users)
    .set({ createdAt: new Date(Date.now() - 30 * 86_400_000) })
    .where(eq(schema.users.id, veteran.userId));
  const folder = (await stack.api(veteran.jar, "POST", "/folders", { name: "V", space: "shared" }))
    .body.node as StorageNode;
  for (const email of [address("a"), address("b"), address("c")]) {
    expect(
      (await stack.api(veteran.jar, "PUT", person(folder.id, email), { role: "viewer" })).status,
    ).toBe(200);
  }
});

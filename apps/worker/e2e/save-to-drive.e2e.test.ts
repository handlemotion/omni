import { randomBytes, randomUUID } from "node:crypto";
import type { StorageNode } from "@omni/contracts";
import { schema } from "@omni/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIB, startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { createMailbox, grant, seedMessage, type CookieJar } from "./support.ts";

const WORKSPACE_BYTES = MIB;

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { STORAGE_MAX_GB: String(WORKSPACE_BYTES / 1024 ** 3) },
  });
});
afterAll(() => stack?.stop());

interface MailBucket {
  put(key: string, body: Uint8Array): Promise<unknown>;
}

async function companyWithAttachment(name: string, mimeType: string, bytes: Uint8Array) {
  const { db } = stack;
  const org = await stack.company(`drive-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const box = await createMailbox(db, org.id, ana.email, "personal");
  await grant(db, org.id, box.id, ana.id);
  const { messageId } = await seedMessage(db, box, {
    subject: "Files",
    fromAddress: "client@example.test",
    uid: 1,
  });
  const r2Key = `${org.id}/${box.id}/att/${randomUUID()}`;
  const env = await stack.worker.server.getWorker<{ MAIL_BUCKET: MailBucket }>().getEnv();
  await env.MAIL_BUCKET.put(r2Key, bytes);
  const [{ id: attachmentId } = { id: "" }] = await db
    .insert(schema.attachments)
    .values({ orgId: org.id, messageId, filename: name, mimeType, size: bytes.length, r2Key })
    .returning({ id: schema.attachments.id });
  return { org, ana, attachmentId };
}

async function save(jar: CookieJar, attachmentId: string, body?: { parentId: string }) {
  const response = await fetch(
    new URL(`/api/mail/attachments/${attachmentId}/save-to-drive`, stack.worker.url),
    {
      method: "POST",
      headers: { cookie: jar.header, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (await response.json()) as any };
}

const myFiles = async (person: Person) =>
  (await stack.api(person.jar, "GET", "/nodes?space=personal")).body.nodes as StorageNode[];

async function storedObjects(orgId: string) {
  const listed = await (await stack.bucket()).list({ prefix: `orgs/${orgId}/` });
  return listed.objects.map((object) => object.key);
}

const uploadsOf = (orgId: string) =>
  stack.db
    .select()
    .from(schema.storageUploads)
    .where(and(eq(schema.storageUploads.orgId, orgId), isNull(schema.storageUploads.nodeId)));

test("a member saves an attachment from a thread they can open into My files, bytes and all", async () => {
  const bytes = randomBytes(300 * 1024);
  const { org, ana, attachmentId } = await companyWithAttachment(
    "Q3 report.pdf",
    "application/pdf",
    bytes,
  );

  const saved = await save(ana.jar, attachmentId);
  expect(saved.status).toBe(201);
  expect(saved.body.node).toMatchObject({
    name: "Q3 report.pdf",
    mimeType: "application/pdf",
    size: bytes.length,
    space: "personal",
    parentId: null,
    ownerMemberId: ana.id,
  });
  expect((await myFiles(ana)).map((node) => node.id)).toEqual([saved.body.node.id]);
  const download = await stack.download(ana.jar, saved.body.node.id);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect(await stack.usedBytes(org.id)).toBe(bytes.length);
});

test("a member who cannot open the thread gets 404 and nothing is written", async () => {
  const { org, attachmentId } = await companyWithAttachment(
    "secret.txt",
    "text/plain",
    randomBytes(64),
  );
  const bea = await stack.member(org.id);

  const refused = await save(bea.jar, attachmentId);
  expect(refused.status).toBe(404);
  expect(refused.body.code).toBe("NOT_FOUND");
  expect(await myFiles(bea)).toEqual([]);
  expect(await storedObjects(org.id)).toEqual([]);
  expect(await uploadsOf(org.id)).toEqual([]);
  expect(await stack.usedBytes(org.id)).toBe(0);
});

test("a full drive answers 402 storage_full and leaves no object behind", async () => {
  const { org, ana, attachmentId } = await companyWithAttachment(
    "big.bin",
    "application/octet-stream",
    randomBytes(200 * 1024),
  );
  const kept = await stack.upload(
    ana.jar,
    { space: "personal" },
    "kept.bin",
    randomBytes(WORKSPACE_BYTES - 100 * 1024),
  );

  const refused = await save(ana.jar, attachmentId);
  expect(refused.status).toBe(402);
  expect(refused.body.code).toBe("STORAGE_FULL");
  expect((await myFiles(ana)).map((node) => node.name)).toEqual(["kept.bin"]);
  expect(await storedObjects(org.id)).toEqual([`orgs/${org.id}/${kept.id}`]);
  expect(await uploadsOf(org.id)).toEqual([]);
  expect(await stack.usedBytes(org.id)).toBe(kept.size);
});

test("saving the same attachment twice gives the second copy a numbered name", async () => {
  const bytes = randomBytes(1000);
  const { org, ana, attachmentId } = await companyWithAttachment("notes.txt", "text/plain", bytes);

  const first = await save(ana.jar, attachmentId);
  const second = await save(ana.jar, attachmentId);
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(first.body.node.name).toBe("notes.txt");
  expect(second.body.node.name).toBe("notes (1).txt");
  expect(second.body.node.id).not.toBe(first.body.node.id);
  expect(await storedObjects(org.id)).toHaveLength(2);
  expect(await stack.usedBytes(org.id)).toBe(2 * bytes.length);
});

test("a member saves into a Shared folder, and never into a teammate's My files", async () => {
  const { org, ana, attachmentId } = await companyWithAttachment(
    "deck.key",
    "application/x-iwork",
    randomBytes(500),
  );
  const folder = await stack.api(ana.jar, "POST", "/folders", { name: "Team", space: "shared" });
  expect(folder.status).toBe(201);

  const saved = await save(ana.jar, attachmentId, { parentId: folder.body.node.id });
  expect(saved.status).toBe(201);
  expect(saved.body.node).toMatchObject({
    name: "deck.key",
    space: "shared",
    parentId: folder.body.node.id,
    ownerMemberId: null,
  });

  const bea = await stack.member(org.id);
  const beaFolder = await stack.api(bea.jar, "POST", "/folders", {
    name: "Mine",
    space: "personal",
  });
  const refused = await save(ana.jar, attachmentId, { parentId: beaFolder.body.node.id });
  expect(refused.status).toBe(404);
  const inside = await stack.api(bea.jar, "GET", `/nodes?parent=${beaFolder.body.node.id}`);
  expect(inside.body.nodes).toEqual([]);
  expect(await storedObjects(org.id)).toEqual([`orgs/${org.id}/${saved.body.node.id}`]);
  expect(await uploadsOf(org.id)).toEqual([]);
});

import { createHash, randomUUID } from "node:crypto";
import type { StorageNode, StorageUpload } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import {
  CookieJar,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  justMe,
  startWorker,
} from "./support.ts";

export const MIB = 1024 * 1024;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Bucket {
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, body: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<{ objects: { key: string }[] }>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    uploadPart(n: number, body: string): Promise<unknown>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
  };
}

export type StorageStack = Awaited<ReturnType<typeof startStorageStack>>;
export type Person = Awaited<ReturnType<StorageStack["member"]>>;

export async function startStorageStack(options: {
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
}) {
  const database = await createTestDatabase();
  const mailService = await startMailServiceEndpoint();
  const worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    ...options,
  });
  const { db } = database;
  const url = (path: string) => new URL(`/api/storage${path}`, worker.url);

  async function api(jar: CookieJar, method: string, path: string, body?: unknown) {
    const response = await fetch(url(path), {
      method,
      headers: { cookie: jar.header, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
  }

  const putPart = (jar: CookieJar, uploadId: string, n: number, bytes: Uint8Array, base = "") =>
    fetch(url(`${base}/uploads/${uploadId}/parts/${n}`), {
      method: "PUT",
      headers: { cookie: jar.header, "content-type": "application/octet-stream" },
      body: new Blob([new Uint8Array(bytes)]),
    });

  async function upload(
    jar: CookieJar,
    place: { space: "personal" | "shared" } | { teamspaceId: string } | { parentId: string },
    name: string,
    bytes: Uint8Array,
    mimeType?: string,
    base = "",
  ) {
    const opened = await api(jar, "POST", `${base}/uploads`, {
      name,
      size: bytes.length,
      mimeType,
      ...place,
    });
    if (opened.status !== 201) throw new Error(`open ${name}: ${opened.status}`);
    const { id, partSize, partCount } = opened.body.upload as StorageUpload;
    for (let n = 1; n <= partCount; n++) {
      const part = bytes.subarray((n - 1) * partSize, n * partSize);
      const sent = await putPart(jar, id, n, part, base);
      if (sent.status !== 200) throw new Error(`part ${n} of ${name}: ${sent.status}`);
      await sent.body?.cancel();
    }
    const done = await api(jar, "POST", `${base}/uploads/${id}/complete`);
    if (done.status !== 200) throw new Error(`complete ${name}: ${done.status}`);
    return done.body.node as StorageNode;
  }

  const get = (jar: CookieJar, path: string, headers: Record<string, string> = {}) =>
    fetch(url(path), { headers: { cookie: jar.header, ...headers } });

  const download = (jar: CookieJar, nodeId: string, headers: Record<string, string> = {}) =>
    get(jar, `/files/${nodeId}/content`, headers);

  return {
    justMe: (jar: CookieJar) => justMe(worker, jar),
    database,
    db,
    worker,
    api,
    putPart,
    upload,
    get,
    download,
    async company(name: string) {
      return createOrg(db, name);
    },
    async member(orgId: string, role: "owner" | "admin" | "member" = "member") {
      const email = `${role}-${randomUUID().slice(0, 8)}@storage.test`;
      const member = await createMember(db, orgId, email);
      await db.update(schema.members).set({ role }).where(eq(schema.members.id, member.id));
      const jar = new CookieJar();
      await signIn(worker, db, email, jar);
      return { ...member, email, jar };
    },
    async bucket() {
      const env = await worker.server.getWorker<{ STORAGE_BUCKET: Bucket }>().getEnv();
      return env.STORAGE_BUCKET;
    },
    async cron(cron: "* * * * *" | "47 3 * * *") {
      return (await worker.server.getWorker().scheduled({ cron })).outcome;
    },
    async usedBytes(orgId: string) {
      const [row] = await db
        .select({ bytes: schema.storageUsage.bytes })
        .from(schema.storageUsage)
        .where(eq(schema.storageUsage.orgId, orgId));
      return row?.bytes ?? 0;
    },
    async stop() {
      await worker.server.close();
      await mailService.close();
      await database.teardown();
    },
  };
}

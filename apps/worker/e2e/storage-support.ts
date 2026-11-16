// What the Storage suites share: a real Worker with its local R2 bucket, people signed in over
// the real magic-link flow, and files uploaded the way a client uploads them.
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
  startWorker,
} from "./support.ts";

export const MIB = 1024 * 1024;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The bucket as the Worker's binding sees it. */
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

  /** A JSON call as `jar`'s browser. The body is parsed when there is one. */
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

  const putPart = (jar: CookieJar, uploadId: string, n: number, bytes: Uint8Array) =>
    fetch(url(`/uploads/${uploadId}/parts/${n}`), {
      method: "PUT",
      headers: { cookie: jar.header, "content-type": "application/octet-stream" },
      body: new Blob([new Uint8Array(bytes)]),
    });

  /** Uploads `bytes` whole: open, every part in order, complete. */
  async function upload(
    jar: CookieJar,
    place: { space: "personal" | "shared" } | { parentId: string },
    name: string,
    bytes: Uint8Array,
    mimeType?: string,
  ): Promise<StorageNode> {
    const opened = await api(jar, "POST", "/uploads", {
      name,
      size: bytes.length,
      mimeType,
      ...place,
    });
    if (opened.status !== 201) throw new Error(`open ${name}: ${opened.status}`);
    const { id, partSize, partCount } = opened.body.upload as StorageUpload;
    for (let n = 1; n <= partCount; n++) {
      const sent = await putPart(jar, id, n, bytes.subarray((n - 1) * partSize, n * partSize));
      if (sent.status !== 200) throw new Error(`part ${n} of ${name}: ${sent.status}`);
      await sent.body?.cancel();
    }
    const done = await api(jar, "POST", `/uploads/${id}/complete`);
    if (done.status !== 200) throw new Error(`complete ${name}: ${done.status}`);
    return done.body.node;
  }

  const download = (jar: CookieJar, nodeId: string, headers: Record<string, string> = {}) =>
    fetch(url(`/files/${nodeId}/content`), { headers: { cookie: jar.header, ...headers } });

  return {
    database,
    db,
    worker,
    api,
    putPart,
    upload,
    download,
    async company(name: string) {
      return createOrg(db, name);
    },
    /** A member of `orgId`, signed in with that company active. */
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
    /** Runs a cron the way Cloudflare does, and answers how it ended. */
    async cron(cron: "* * * * *" | "47 3 * * *"): Promise<string> {
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

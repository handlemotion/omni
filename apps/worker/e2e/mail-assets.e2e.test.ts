import { createHash } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

async function member(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  const bea = await createMember(db, org.id, `bea@${slug}.test`);
  const anaBox = await createMailbox(db, org.id, `ana@${slug}.test`, "personal");
  const beaBox = await createMailbox(db, org.id, `bea@${slug}.test`, "personal");
  await grant(db, org.id, anaBox.id, ana.id);
  await grant(db, org.id, beaBox.id, bea.id);
  return {
    org,
    anaBox,
    anaCookie: await signIn(worker, db, `ana@${slug}.test`),
    beaCookie: await signIn(worker, db, `bea@${slug}.test`),
  };
}

describe("attachments and message HTML", () => {
  test("load only for members who can see the message, and never render active content", async () => {
    const { db } = database;
    const { org, anaBox, anaCookie, beaCookie } = await member("files");
    const { messageId, threadId } = await seedMessage(db, anaBox, {
      subject: "Files",
      fromAddress: "x@client.test",
      uid: 1,
    });
    // The Worker's real local R2 binding, which the mail service's bucket is in production.
    const env = await worker.server
      .getWorker<{ MAIL_BUCKET: { put(key: string, body: string | Buffer): Promise<unknown> } }>()
      .getEnv();
    const store = async (name: string, mimeType: string, body: string | Buffer) => {
      const sha = createHash("sha256").update(body).digest("hex");
      const r2Key = `${org.id}/${anaBox.id}/att/${sha}`;
      await env.MAIL_BUCKET.put(r2Key, body);
      await db.insert(schema.attachments).values({
        orgId: org.id,
        messageId,
        filename: name,
        mimeType,
        size: Buffer.byteLength(body),
        r2Key,
      });
      return sha;
    };
    const png = await store("dot.png", "image/png", PNG);
    const html = await store("evil.html", "text/html", "<script>alert(1)</script>");
    const svg = await store("logo.svg", "image/svg+xml", "<svg><script>alert(1)</script></svg>");
    const get = (path: string, cookie: string) =>
      fetch(new URL(`/api${path}`, worker.url), { headers: { cookie } });

    const image = await get(`/attachments/${png}`, anaCookie);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");

    for (const sha of [html, svg]) {
      const download = await get(`/attachments/${sha}`, anaCookie);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(download.headers.get("content-security-policy")).toContain("sandbox");
      await download.body?.cancel();
    }

    // Bea has no access to Ana's mailbox; a valid hash tells her nothing.
    expect((await get(`/attachments/${png}`, beaCookie)).status).toBe(404);
    expect((await get(`/attachments/${png}`, "")).status).toBe(401);

    const htmlKey = `${org.id}/${anaBox.id}/html/${messageId}.html`;
    await env.MAIL_BUCKET.put(htmlKey, "<p>Hello <img src='/api/attachments/x'></p>");
    await db
      .update(schema.messages)
      .set({ htmlR2Key: htmlKey })
      .where(eq(schema.messages.id, messageId));
    const page = await get(`/threads/${threadId}/messages/${messageId}/html`, anaCookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hello");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-scripts");
    expect((await get(`/threads/${threadId}/messages/${messageId}/html`, beaCookie)).status).toBe(
      404,
    );
  });
});

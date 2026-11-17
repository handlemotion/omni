import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seedMailbox, stored } from "./support/db.ts";
import type { FirstSyncInput, FirstSyncOutput } from "./support/first-sync-child.ts";
import { otherClient } from "./support/greenmail.ts";
import { createTestBucket } from "./support/objects.ts";

const run = promisify(execFile);
const child = fileURLToPath(new URL("./support/first-sync-child.ts", import.meta.url));

const MACHINE_MB = 512;
const HEAP_MB = MACHINE_MB / 2;
const MESSAGES = 120;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let bucket: Awaited<ReturnType<typeof createTestBucket>>;

beforeAll(async () => {
  database = await createTestDatabase();
  bucket = await createTestBucket();
});

afterAll(async () => {
  await database.teardown();
});

describe("first sync on the smallest supported machine", () => {
  it("imports a newsletter-heavy INBOX within that machine's memory", async () => {
    const { box } = await seedMailbox(database.db);
    await otherClient(box, async (client) => {
      for (let i = 0; i < MESSAGES; i++) await client.append("INBOX", newsletter(i), []);
    });

    const input: FirstSyncInput = { databaseUrl: database.url, bucket: bucket.options, box };
    const { stdout } = await run(process.execPath, [`--max-old-space-size=${HEAP_MB}`, child], {
      env: { ...process.env, FIRST_SYNC: JSON.stringify(input) },
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as FirstSyncOutput;

    expect(result.messages).toBe(MESSAGES);
    expect(await stored(database.db, box.id, "INBOX")).toHaveLength(MESSAGES);
    expect(result.peakRssMb).toBeLessThan(MACHINE_MB * 0.75);
    expect(result.seconds / MESSAGES).toBeLessThan(0.5);
  });
});

const newsletter: (i: number) => Buffer = (i) => {
  const rows: string[] = [];
  for (let size = 0, r = 0; size < 80 * 1024; r++) {
    const row = `<tr><td style="padding:12px 24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#333333" class="text"><table border="0" cellpadding="0" cellspacing="0" width="100%"><tbody><tr><td valign="top"><a href="https://click.brand.test/t/${i}/${r}?utm_source=nl&amp;utm_medium=email" target="_blank" style="color:#0a66c2;text-decoration:none"><img src="https://img.brand.test/${i}/${r}.png" width="560" height="120" alt="Item ${r}" style="display:block;border:0"></a><p style="margin:8px 0">Offer ${r} of issue ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit.</p></td></tr></tbody></table></td></tr>\r\n`;
    rows.push(row);
    size += row.length;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>.text{word-break:break-word}@media only screen and (max-width:480px){table{width:100%!important}}</style></head><body><table width="600" align="center">${rows.join("")}</table><img src="https://open.brand.test/${i}.gif" width="1" height="1"></body></html>`;
  return Buffer.from(
    [
      `From: Brand ${i % 7} <news@brand${i % 7}.test>`,
      "To: me@omni.test",
      `Subject: Weekly deals ${i}`,
      `Message-ID: <issue-${i}-${Date.now()}@brand.test>`,
      `Date: ${new Date(Date.now() - i * 3_600_000).toUTCString()}`,
      `List-Unsubscribe: <https://brand.test/u/${i}>`,
      "MIME-Version: 1.0",
      "Content-Type: multipart/alternative; boundary=alt",
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Weekly deals ${i}. View in browser.`,
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
      "--alt--",
      "",
    ].join("\r\n"),
  );
};

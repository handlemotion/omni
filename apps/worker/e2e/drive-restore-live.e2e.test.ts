import { randomUUID } from "node:crypto";
import { rewriteLive } from "@omni/docs";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { base64, bytes, editor, S2, type Event } from "./live-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_ACTIONS: "off",
      S2_BASIN_URL: S2.url,
      S2_BASIN: S2.basin,
      STORAGE_MAX_GB: "1",
    },
  });
}, 120_000);
afterAll(() => stack?.stop());

async function save(jar: CookieJar, nodeId: string, text: string, base: number) {
  const body = bytes(text);
  const opened = await stack.api(jar, "POST", `/files/${nodeId}/versions`, {
    size: body.length,
    mimeType: "text/markdown",
    ifContentVersion: base,
  });
  expect(opened.status).toBe(201);
  const { id } = opened.body.upload as { id: string };
  expect((await stack.putPart(jar, id, 1, body)).status).toBe(200);
  expect((await stack.api(jar, "POST", `/uploads/${id}/complete`)).status).toBe(200);
}

async function openWithOlder(first: string, second: string) {
  const org = await stack.company(`restore-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(first));
  await save(ana.jar, doc.id, second, 1);
  const listed = await stack.api(ana.jar, "GET", `/files/${doc.id}/versions`);
  const [older] = listed.body.versions as { id: string }[];
  const tab = await editor(stack, ana.jar, doc.id);
  const typing = new Y.Doc();
  await tab.append({ t: "seed", cv: 2, u: base64(rewriteLive(typing, second)) }, 0);
  const restore = () =>
    stack.api(ana.jar, "POST", `/files/${doc.id}/versions/${older!.id}/restore`);
  return { org, ana, doc, tab, restore };
}

test("a version restored live stays a version of its own when its restorer keeps typing", async () => {
  const first = "# Plan\n\nFirst draft";
  const { ana, doc, tab, restore } = await openWithOlder(first, "# Plan\n\nSecond draft");
  expect((await restore()).status).toBe(200);
  await tab.waitFor((e) => e.type === "doc.record" && (e.record as Event).t === "fold");
  await save(ana.jar, doc.id, `${first}, and more`, 3);

  const listed = await stack.api(ana.jar, "GET", `/files/${doc.id}/versions`);
  const sizes = (listed.body.versions as { size: number }[]).map((v) => v.size);
  expect(sizes.filter((size) => size === bytes(first).length)).toHaveLength(2);
  tab.socket.close();
});

test("a version too large for the live document is restored as the file", async () => {
  const big = `# Log\n\n${"A line of the log. ".repeat(60_000)}`;
  expect(bytes(big).length).toBeGreaterThan(1_000_000);
  const { ana, doc, tab, restore } = await openWithOlder(big, "# Log\n\nCleared");
  const restored = await restore();
  expect(restored.status).toBe(200);
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(big);
  tab.socket.close();
});

test("a version of an open doc is restored in a full workspace, as the file was before", async () => {
  const first = "# Plan\n\nFirst draft";
  const { org, ana, doc, tab, restore } = await openWithOlder(first, "# Plan\n\nSecond draft");
  await stack.db
    .update(schema.storageUsage)
    .set({ bytes: 10 ** 15 })
    .where(eq(schema.storageUsage.orgId, org.id));
  const restored = await restore();
  expect(restored.status).toBe(200);
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(first);
  tab.socket.close();
});

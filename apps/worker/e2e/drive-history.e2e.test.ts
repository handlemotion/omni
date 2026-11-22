import { randomUUID } from "node:crypto";
import { liveMarkdown, rewriteLive } from "@omni/docs";
import { schema } from "@omni/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { base64, bytes, editor, S2, trim } from "./live-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, S2_BASIN_URL: S2.url, S2_BASIN: S2.basin },
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
  const part = await stack.putPart(jar, id, 1, body);
  expect(part.status).toBe(200);
  const done = await stack.api(jar, "POST", `/uploads/${id}/complete`);
  expect(done.status).toBe(200);
}

const changesOf = (nodeId: string) =>
  stack.db
    .select()
    .from(schema.storageDocChanges)
    .where(eq(schema.storageDocChanges.nodeId, nodeId))
    .orderBy(asc(schema.storageDocChanges.firstSeq));

test("a doc's change log outlives its stream: runs by author in the order typed, over the seed, written once", async () => {
  const org = await stack.company(`history-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const first = "# Plan\n\nIntro";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(first));
  const [anaTab, boTab] = [
    await editor(stack, ana.jar, doc.id),
    await editor(stack, bo.jar, doc.id),
  ];

  const page = new Y.Doc();
  const seed = base64(rewriteLive(page, first));
  const epoch = await anaTab.append({ t: "seed", cv: 1, u: seed }, 0);
  const typed = [
    [anaTab, `${first}\n\nAna's line`],
    [boTab, `${first}\n\nAna's line\n\nBo's line`],
    [anaTab, `${first}\n\nAna's line\n\nBo's line, Ana edits it`],
    [anaTab, `${first}\n\nAna's line, twice\n\nBo's line, Ana edits it`],
  ] as const;
  for (const [tab, text] of typed) {
    await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(page, text)) });
  }
  const last = typed.at(-1)![1];
  await save(ana.jar, doc.id, last, 1);

  await expect.poll(async () => (await changesOf(doc.id)).length, { timeout: 10_000 }).toBe(3);
  const runs = await changesOf(doc.id);
  expect(runs.map((run) => [run.by, run.authorName, run.firstSeq, run.lastSeq])).toEqual([
    [`m:${ana.id}`, ana.email, epoch + 1, epoch + 1],
    [`m:${bo.id}`, bo.email, epoch + 2, epoch + 2],
    [`m:${ana.id}`, ana.email, epoch + 3, epoch + 4],
  ]);
  const baselines = await stack.db
    .select()
    .from(schema.storageDocBaselines)
    .where(eq(schema.storageDocBaselines.nodeId, doc.id));
  expect(baselines.map((b) => [b.epoch, b.seq, b.state])).toEqual([[epoch, epoch, seed]]);

  const replayed = new Y.Doc();
  Y.applyUpdate(replayed, Buffer.from(baselines[0]!.state, "base64"));
  for (const run of runs) Y.applyUpdate(replayed, Buffer.from(run.update, "base64"));
  expect(liveMarkdown(replayed)).toBe(last);

  await trim(doc.id, epoch + 5);
  expect(await stack.cron("* * * * *")).toBe("ok");
  expect(await changesOf(doc.id)).toEqual(runs);
  for (const tab of [anaTab, boTab]) tab.socket.close();
});

test("typing left in an epoch when a new one starts is journaled before the journal moves on", async () => {
  const org = await stack.company(`epochs-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Notes\n\nOne";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes(first));
  const tab = await editor(stack, ana.jar, doc.id);
  const page = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(page, first)) }, 0);
  const saved = `${first}\n\nTwo`;
  await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(page, saved)) });
  await save(ana.jar, doc.id, saved, 1);
  await expect.poll(async () => (await changesOf(doc.id)).length, { timeout: 10_000 }).toBe(1);

  const left = await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, `${saved}\n\nThree, never saved`)),
  });
  const next = new Y.Doc();
  const newer = await tab.append({ t: "seed", cv: 2, u: base64(rewriteLive(next, saved)) });
  expect(await stack.cron("* * * * *")).toBe("ok");
  await save(ana.jar, doc.id, `${saved}\n\nFour`, 2);
  await expect
    .poll(async () => (await changesOf(doc.id)).map((run) => [run.epoch, run.firstSeq]))
    .toContainEqual([epoch, left]);
  const journalEpoch = async () =>
    (
      await stack.db
        .select({ epoch: schema.storageDocJournals.epoch })
        .from(schema.storageDocJournals)
        .where(eq(schema.storageDocJournals.nodeId, doc.id))
    )[0]?.epoch;
  await expect.poll(journalEpoch, { timeout: 10_000 }).toBe(newer);
  tab.socket.close();
});

import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { storageDocBaselines, storageDocChanges, storageDocJournals } from "../src/schema/index.ts";
import { purgeDocHistory, writeDocJournal, type DocRun } from "../src/storage.ts";
import { addFile } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const DAY_MS = 24 * 60 * 60_000;

const run = (firstSeq: number, endedDaysAgo: number) => {
  const at = new Date(Date.now() - endedDaysAgo * DAY_MS);
  const made: DocRun = {
    firstSeq,
    lastSeq: firstSeq,
    by: "m:x",
    authorName: null,
    agent: null,
    startedAt: at,
    endedAt: at,
    update: "AA==",
  };
  return made;
};

test("the purge drops old runs and the baselines no remaining run needs, but keeps the one they start from", async () => {
  const org = await createOrg(db, "history-purge");
  const member = await createMember(db, org.id, "ana");
  const file = await addFile(forMember(db, member.id).storage, { space: "personal" }, "a.md", 3);
  let cursor: { epoch: number; lastSeq: number } | null = null;
  const write = async (
    runs: DocRun[],
    baseline: { seq: number; state: string } | null,
    lastSeq: number,
  ) => {
    const written = await writeDocJournal(db, {
      orgId: org.id,
      nodeId: file.id,
      epoch: 0,
      lastSeq,
      contentVersion: 1,
      runs,
      baseline,
      sinceBaseline: 0,
      expected: cursor,
    });
    if (written) cursor = { epoch: 0, lastSeq };
    return written;
  };
  await write([run(1, 40), run(2, 40)], { seq: 0, state: "seed" }, 2);
  await write([run(3, 35)], { seq: 2, state: "checkpoint-2" }, 3);
  await write([run(4, 1)], { seq: 3, state: "checkpoint-3" }, 4);
  expect(await write([run(4, 1)], null, 4)).toBe(true);
  await db
    .update(storageDocBaselines)
    .set({ createdAt: new Date(Date.now() - 40 * DAY_MS) })
    .where(eq(storageDocBaselines.nodeId, file.id));

  expect(await purgeDocHistory(db, new Date(Date.now() - 30 * DAY_MS))).toBe(3);

  const runs = await db
    .select({ firstSeq: storageDocChanges.firstSeq })
    .from(storageDocChanges)
    .where(eq(storageDocChanges.nodeId, file.id));
  expect(runs).toEqual([{ firstSeq: 4 }]);
  const kept = await db
    .select({ seq: storageDocBaselines.seq })
    .from(storageDocBaselines)
    .where(eq(storageDocBaselines.nodeId, file.id));
  expect(kept).toEqual([{ seq: 3 }]);
});

test("two journal runs from the same cursor take turns: the second writes nothing and reads again", async () => {
  const org = await createOrg(db, "history-race");
  const member = await createMember(db, org.id, "ana");
  const file = await addFile(forMember(db, member.id).storage, { space: "personal" }, "b.md", 3);
  const from = (runs: DocRun[], lastSeq: number) =>
    writeDocJournal(db, {
      orgId: org.id,
      nodeId: file.id,
      epoch: 0,
      lastSeq,
      contentVersion: 1,
      runs,
      baseline: null,
      sinceBaseline: 0,
      expected: null,
    });
  const short = { ...run(1, 0), lastSeq: 2 };
  const long = { ...run(1, 0), lastSeq: 3 };
  const [a, b] = await Promise.all([from([short], 2), from([long], 3)]);
  expect([a, b].sort()).toEqual([false, true]);
  const [journal] = await db
    .select({ lastSeq: storageDocJournals.lastSeq })
    .from(storageDocJournals)
    .where(eq(storageDocJournals.nodeId, file.id));
  const [kept] = await db
    .select({ lastSeq: storageDocChanges.lastSeq })
    .from(storageDocChanges)
    .where(eq(storageDocChanges.nodeId, file.id));
  expect(journal!.lastSeq).toBe(kept!.lastSeq);
});

test("the purge keeps an expired run that a kept one still needs to replay", async () => {
  const org = await createOrg(db, "history-purge-needed");
  const member = await createMember(db, org.id, "ana");
  const file = await addFile(forMember(db, member.id).storage, { space: "personal" }, "c.md", 3);
  await writeDocJournal(db, {
    orgId: org.id,
    nodeId: file.id,
    epoch: 0,
    lastSeq: 2,
    contentVersion: 1,
    runs: [run(1, 40), run(2, 1)],
    baseline: { seq: 0, state: "seed" },
    sinceBaseline: 2,
    expected: null,
  });

  await purgeDocHistory(db, new Date(Date.now() - 30 * DAY_MS));

  const left = await db
    .select({ firstSeq: storageDocChanges.firstSeq })
    .from(storageDocChanges)
    .where(eq(storageDocChanges.nodeId, file.id));
  expect(left.map((row) => row.firstSeq).sort()).toEqual([1, 2]);
});

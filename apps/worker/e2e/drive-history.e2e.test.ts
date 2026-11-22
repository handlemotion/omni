import { randomUUID } from "node:crypto";
import { splitLiveRecord } from "@omni/contracts";
import { liveMarkdown, rewriteLive } from "@omni/docs";
import { schema } from "@omni/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import { base64, bytes, call, editor, S2, trim, WRITE } from "./live-support.ts";
import { connectAgent } from "./mcp-support.ts";
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

const liveChangesOf = async (nodeId: string) =>
  (await changesOf(nodeId)).filter((run) => run.update !== "");

const settled = (nodeId: string, contentVersion: number) =>
  expect
    .poll(
      async () =>
        (
          await stack.db
            .select({ cv: schema.storageDocJournals.contentVersion })
            .from(schema.storageDocJournals)
            .where(eq(schema.storageDocJournals.nodeId, nodeId))
        )[0]?.cv,
      { timeout: 10_000 },
    )
    .toBe(contentVersion);

test("a doc's change log outlives its stream: runs by author in the order typed, over the seed, written once", async () => {
  const org = await stack.company(`history-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const first = "# Plan\n\nIntro";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(first));
  await settled(doc.id, 1);
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
    await tab.append({
      t: "update",
      e: epoch,
      u: base64(rewriteLive(page, text)),
    });
  }
  const last = typed.at(-1)![1];
  await save(ana.jar, doc.id, last, 1);
  await anaTab.append({ t: "fold", e: epoch, cv: 2, s: epoch + 4 });

  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(3);
  const runs = await liveChangesOf(doc.id);
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
  expect(await liveChangesOf(doc.id)).toEqual(runs);
  const saves = (await changesOf(doc.id)).filter((run) => run.update === "");
  expect(saves.map((run) => [run.firstSeq, run.by, run.contentVersion])).toEqual([
    [-1, `m:${ana.id}`, 1],
  ]);
  for (const tab of [anaTab, boTab]) tab.socket.close();
});

test("typing left in an epoch when a new one starts is journaled before the journal moves on", async () => {
  const org = await stack.company(`epochs-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Notes\n\nOne";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes(first));
  await settled(doc.id, 1);
  const tab = await editor(stack, ana.jar, doc.id);
  const page = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(page, first)) }, 0);
  const saved = `${first}\n\nTwo`;
  await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, saved)),
  });
  await save(ana.jar, doc.id, saved, 1);
  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(1);

  const left = await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, `${saved}\n\nThree, never saved`)),
  });
  const next = new Y.Doc();
  const newer = await tab.append({
    t: "seed",
    cv: 2,
    u: base64(rewriteLive(next, saved)),
  });
  expect(await stack.cron("* * * * *")).toBe("ok");
  await save(ana.jar, doc.id, `${saved}\n\nFour`, 2);
  await expect
    .poll(async () => (await liveChangesOf(doc.id)).map((run) => [run.epoch, run.firstSeq]))
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

test("History lists sessions newest first with who wrote in them, and an agent's edit as its own session, diffed by block", async () => {
  const org = await stack.company(`sessions-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const outsider = await stack.member(
    (await stack.company(`other-${randomUUID().slice(0, 8)}`)).id,
  );
  const first = "# Launch\n\nBook the venue";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "launch.md", bytes(first));
  await settled(doc.id, 1);
  const [anaTab, boTab] = [
    await editor(stack, ana.jar, doc.id),
    await editor(stack, bo.jar, doc.id),
  ];
  const page = new Y.Doc();
  const epoch = await anaTab.append({ t: "seed", cv: 1, u: base64(rewriteLive(page, first)) }, 0);
  const people = `${first}\n\nSend invites\n\nOrder food`;
  await anaTab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, `${first}\n\nSend invites`)),
  });
  const typedTo = await boTab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, people)),
  });
  await save(ana.jar, doc.id, people, 1);
  await anaTab.append({ t: "fold", e: epoch, cv: 2, s: typedTo });
  await expect.poll(async () => (await changesOf(doc.id)).length, { timeout: 10_000 }).toBe(3);

  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "Order food", replace: "Order food for forty" }],
  });
  expect(edited).not.toHaveProperty("error");
  await expect.poll(async () => (await changesOf(doc.id)).length, { timeout: 10_000 }).toBe(4);

  const listed = await stack.api(ana.jar, "GET", `/files/${doc.id}/history`);
  expect(listed.status).toBe(200);
  expect(listed.body).toMatchObject({
    keepDays: 30,
    sessions: [
      {
        authors: [{ kind: "agent", name: ana.email, agent: "Drive agent" }],
        contentVersion: 3,
        restorable: true,
      },
      {
        authors: [
          { kind: "member", name: ana.email, agent: null },
          { kind: "member", name: bo.email, agent: null },
        ],
        contentVersion: 2,
        restorable: true,
      },
      { authors: [{ kind: "member", name: ana.email, agent: null }], contentVersion: 1 },
    ],
  });
  const [byAgent, byPeople] = listed.body.sessions as { id: string }[];

  const agentDiff = await stack.api(ana.jar, "GET", `/files/${doc.id}/history/${byAgent!.id}`);
  expect(agentDiff.body.counts).toEqual({ added: 0, removed: 0, changed: 1 });
  expect(agentDiff.body.blocks).toContainEqual(
    expect.objectContaining({
      kind: "changed",
      before: "Order food",
      after: "Order food for forty",
    }),
  );
  const peopleDiff = await stack.api(ana.jar, "GET", `/files/${doc.id}/history/${byPeople!.id}`);
  expect(peopleDiff.body.counts).toEqual({ added: 2, removed: 0, changed: 0 });

  expect((await stack.api(outsider.jar, "GET", `/files/${doc.id}/history`)).status).toBe(404);
  for (const tab of [anaTab, boTab]) tab.socket.close();
});

test("an agent's edit of a doc nobody has open is in its History too, named for the agent", async () => {
  const org = await stack.company(`quiet-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes("# Notes\n\nOne"));
  await settled(doc.id, 1);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    markdown: "# Notes\n\nOne\n\nTwo",
  });
  expect(edited).not.toHaveProperty("error");
  await settled(doc.id, 2);

  const listed = await stack.api(ana.jar, "GET", `/files/${doc.id}/history`);
  expect(listed.body.sessions).toMatchObject([
    {
      authors: [{ kind: "agent", name: ana.email, agent: "Drive agent" }],
      contentVersion: 2,
    },
    { authors: [{ kind: "member", name: ana.email, agent: null }], contentVersion: 1 },
  ]);
  const [only] = listed.body.sessions as { id: string }[];
  const diff = await stack.api(ana.jar, "GET", `/files/${doc.id}/history/${only!.id}`);
  expect(diff.body.counts).toEqual({ added: 1, removed: 0, changed: 0 });
  expect(await call(agent, "drive_versions", { id: doc.id })).toMatchObject({
    sessions: [
      { id: only!.id, authors: [{ name: ana.email, agent: "Drive agent" }] },
      { authors: [{ name: ana.email, agent: null }] },
    ],
  });
});

test("a session's diff is rebuilt from the journal: from before its first save, per session when journaled late, and unavailable once its baseline is gone", async () => {
  const org = await stack.company(`replay-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Plan\n\nStart";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(first));
  await settled(doc.id, 1);
  const tab = await editor(stack, ana.jar, doc.id);
  const page = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(page, first)) }, 0);
  const one = `${first}\n\nOne`;
  const two = `${one}\n\nTwo`;
  let at = await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, one)),
  });
  await save(ana.jar, doc.id, one, 1);
  await tab.append({ t: "fold", e: epoch, cv: 2, s: at });
  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(1);
  at = await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, two)),
  });
  await save(ana.jar, doc.id, two, 2);
  await tab.append({ t: "fold", e: epoch, cv: 3, s: at });
  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(2);

  const sessionsOf = async () =>
    (await stack.api(ana.jar, "GET", `/files/${doc.id}/history`)).body.sessions as {
      id: string;
      versionId: string | null;
    }[];
  const diffOf = async (id: string) =>
    (await stack.api(ana.jar, "GET", `/files/${doc.id}/history/${id}`)).body;
  const [both] = await sessionsOf();
  expect(await diffOf(both!.id)).toMatchObject({
    available: true,
    counts: { added: 2, removed: 0, changed: 0 },
  });

  const [, second] = await liveChangesOf(doc.id);
  await stack.db
    .update(schema.storageDocChanges)
    .set({
      startedAt: new Date(Date.now() + 10 * 60_000),
      endedAt: new Date(Date.now() + 10 * 60_000),
    })
    .where(eq(schema.storageDocChanges.id, second!.id));
  await stack.db
    .update(schema.storageDocChanges)
    .set({ contentVersion: 3 })
    .where(eq(schema.storageDocChanges.nodeId, doc.id));
  const late = await sessionsOf();
  expect(late).toHaveLength(3);
  expect(late.map((s) => s.versionId)).toEqual([null, null, null]);
  expect((await diffOf(late[0]!.id)).blocks).toEqual([
    { kind: "same", text: "# Plan" },
    { kind: "same", text: "Start" },
    { kind: "same", text: "One" },
    { kind: "added", text: "Two" },
  ]);
  expect((await diffOf(late[1]!.id)).counts).toEqual({
    added: 1,
    removed: 0,
    changed: 0,
  });

  await stack.db
    .delete(schema.storageDocBaselines)
    .where(eq(schema.storageDocBaselines.nodeId, doc.id));
  expect(await diffOf(late[1]!.id)).toMatchObject({
    available: false,
    blocks: [],
  });
  tab.socket.close();
});

test("saves journaled late are each named for their own writer, not the one who wrote last", async () => {
  const org = await stack.company(`writers-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "memo.md", bytes("# Memo"));
  await settled(doc.id, 1);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    markdown: "# Memo\n\nBy the agent",
  });
  expect(edited).not.toHaveProperty("error");
  await save(ana.jar, doc.id, "# Memo\n\nBy the agent\n\nBy Ana", 2);
  await settled(doc.id, 3);

  for (const table of [schema.storageDocChanges, schema.storageDocJournals]) {
    await stack.db.delete(table).where(eq(table.nodeId, doc.id));
  }
  expect(await stack.cron("* * * * *")).toBe("ok");
  const rows = await changesOf(doc.id);
  expect(rows.map((row) => [row.firstSeq, row.by])).toEqual([
    [-3, `m:${ana.id}`],
    [-2, `a:${ana.id}:Drive agent`],
    [-1, `m:${ana.id}`],
  ]);
});

test("typing left in each of several epochs is journaled, epoch by epoch, before the journal reaches the latest", async () => {
  const org = await stack.company(`three-epochs-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Log\n\nA";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "log.md", bytes(first));
  await settled(doc.id, 1);
  const tab = await editor(stack, ana.jar, doc.id);
  const a = new Y.Doc();
  const epochA = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(a, first)) }, 0);
  await tab.append({
    t: "update",
    e: epochA,
    u: base64(rewriteLive(a, `${first}\n\nA1`)),
  });
  await save(ana.jar, doc.id, `${first}\n\nA1`, 1);
  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(1);

  const leftA = await tab.append({
    t: "update",
    e: epochA,
    u: base64(rewriteLive(a, `${first}\n\nA2`)),
  });
  const b = new Y.Doc();
  const epochB = await tab.append({
    t: "seed",
    cv: 2,
    u: base64(rewriteLive(b, "# Log\n\nB")),
  });
  const leftB = await tab.append({
    t: "update",
    e: epochB,
    u: base64(rewriteLive(b, "# Log\n\nB1")),
  });
  const c = new Y.Doc();
  const epochC = await tab.append({
    t: "seed",
    cv: 2,
    u: base64(rewriteLive(c, "# Log\n\nC")),
  });
  await save(ana.jar, doc.id, "# Log\n\nC1", 2);

  await expect
    .poll(async () => (await liveChangesOf(doc.id)).map((run) => [run.epoch, run.firstSeq]), {
      timeout: 10_000,
    })
    .toEqual(
      expect.arrayContaining([
        [epochA, leftA],
        [epochB, leftB],
      ]),
    );
  await expect
    .poll(
      async () =>
        (
          await stack.db
            .select({ epoch: schema.storageDocJournals.epoch })
            .from(schema.storageDocJournals)
            .where(eq(schema.storageDocJournals.nodeId, doc.id))
        )[0]?.epoch,
      { timeout: 10_000 },
    )
    .toBe(epochC);
  tab.socket.close();
});

test("saves made outside the live document are journaled with typing still pending in it, each at its own version", async () => {
  const org = await stack.company(`pending-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "brief.md", bytes("# Brief"));
  await settled(doc.id, 1);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const written = "# Brief\n\nFrom the agent";
  expect(await call(agent, "drive_edit_doc", { id: doc.id, markdown: written })).not.toHaveProperty(
    "error",
  );
  await settled(doc.id, 2);
  for (const table of [schema.storageDocChanges, schema.storageDocJournals]) {
    await stack.db.delete(table).where(eq(table.nodeId, doc.id));
  }

  const tab = await editor(stack, ana.jar, doc.id);
  const page = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 2, u: base64(rewriteLive(page, written)) }, 0);
  await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(page, `${written}\n\nAna`)),
  });
  expect(await stack.cron("* * * * *")).toBe("ok");
  const rows = await changesOf(doc.id);
  expect(
    rows.map((row) => [row.firstSeq < 0 ? row.firstSeq : "live", row.by, row.contentVersion]),
  ).toEqual([
    [-2, `a:${ana.id}:Drive agent`, 2],
    [-1, `m:${ana.id}`, 1],
    ["live", `m:${ana.id}`, 2],
  ]);
  tab.socket.close();
});

test("a page's save journaled before its fold lands is not listed twice; one that never gets a fold is, once the grace passes", async () => {
  const org = await stack.company(`fold-race-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Agenda";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "agenda.md", bytes(first));
  await settled(doc.id, 1);
  const tab = await editor(stack, ana.jar, doc.id);
  const page = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(page, first)) }, 0);
  const one = `${first}\n\nOne`;
  const at = await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(page, one)) });
  await save(ana.jar, doc.id, one, 1);
  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(1);
  await tab.append({ t: "fold", e: epoch, cv: 2, s: at });
  expect(await stack.cron("* * * * *")).toBe("ok");
  await settled(doc.id, 2);
  const writes = async () =>
    (await changesOf(doc.id)).filter((run) => run.update === "").map((run) => run.firstSeq);
  expect(await writes()).toEqual([-1]);

  const two = `${one}\n\nTwo`;
  await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(page, two)) });
  await save(ana.jar, doc.id, two, 2);
  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(2);
  expect(await writes()).toEqual([-1]);
  await stack.db
    .update(schema.storageContents)
    .set({ writtenAt: new Date(Date.now() - 5 * 60_000) })
    .where(eq(schema.storageContents.nodeId, doc.id));
  expect(await stack.cron("* * * * *")).toBe("ok");
  await settled(doc.id, 3);
  expect(await writes()).toEqual([-3, -1]);
  tab.socket.close();
});

test("a paste split into parts is journaled whole, at its head, once its last part is in", async () => {
  const org = await stack.company(`split-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Long\n\nStart";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "long.md", bytes(first));
  await settled(doc.id, 1);
  const tab = await editor(stack, ana.jar, doc.id);
  const page = new Y.Doc();
  const seed = base64(rewriteLive(page, first));
  const epoch = await tab.append({ t: "seed", cv: 1, u: seed }, 0);
  const pasted = `${first}\n\n${Array.from({ length: 560 }, (_, i) => `${i} ${"dolor sitam ".repeat(130)}`).join("\n\n")}`;
  const paste = splitLiveRecord({ t: "update", e: epoch, u: base64(rewriteLive(page, pasted)) });
  expect(paste.head.n).toBeGreaterThan(1);
  const head = await tab.append(paste.head);
  let last = head;
  for (const part of paste.rest(head)) last = await tab.append(part);
  await save(ana.jar, doc.id, pasted, 1);
  await tab.append({ t: "fold", e: epoch, cv: 2, s: last });

  await expect.poll(async () => (await liveChangesOf(doc.id)).length, { timeout: 10_000 }).toBe(1);
  const [run] = await liveChangesOf(doc.id);
  expect([run!.by, run!.firstSeq, run!.lastSeq]).toEqual([`m:${ana.id}`, head, head]);
  const replayed = new Y.Doc();
  Y.applyUpdate(replayed, Buffer.from(seed, "base64"));
  Y.applyUpdate(replayed, Buffer.from(run!.update, "base64"));
  expect(liveMarkdown(replayed)).toBe(pasted);
  tab.socket.close();
});

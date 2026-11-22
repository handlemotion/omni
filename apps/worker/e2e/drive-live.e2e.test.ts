import { randomUUID } from "node:crypto";
import {
  LiveParts,
  splitLiveRecord,
  STORAGE_LIVE_SNAP_EVERY,
  type StorageLiveEntry,
} from "@omni/contracts";
import { liveMarkdown, rewriteLive } from "@omni/docs";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";
import {
  base64,
  bytes,
  call,
  editor as openEditor,
  S2,
  trim,
  WRITE,
  type Event,
} from "./live-support.ts";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

const editor = (jar: CookieJar, nodeId: string) => openEditor(stack, jar, nodeId);

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

test("a doc edited past its stream's retention opens from its snap, and an agent's edit keeps the typing nobody saved", async () => {
  const org = await stack.company(`live-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Notes\n\nFirst line";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes(first));
  const tab = await editor(ana.jar, doc.id);

  const typing = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(typing, first)) }, 0);
  let last = epoch;
  for (let i = 1; i <= STORAGE_LIVE_SNAP_EVERY; i++) {
    const u = base64(rewriteLive(typing, `${first}\n\nDraft ${i}`));
    last = await tab.append({ t: "update", e: epoch, u });
  }
  const snap = {
    t: "snap",
    e: epoch,
    s: last,
    cv: 1,
    f: epoch,
    u: base64(Y.encodeStateAsUpdate(typing)),
  };
  const snapAt = await tab.append(snap);
  const typed = `${first}\n\nDraft ${STORAGE_LIVE_SNAP_EVERY}\n\nTyped after the snap`;
  const after = { t: "update", e: epoch, u: base64(rewriteLive(typing, typed)) };
  await tab.append(after);
  await trim(doc.id, last + 1);

  const opened = await stack.api(ana.jar, "GET", `/files/${doc.id}/live?from=latest`);
  expect(opened.body).toEqual({
    enabled: true,
    entries: [
      { seqNum: snapAt, record: { ...snap, by: `m:${ana.id}` } },
      { seqNum: snapAt + 1, record: { ...after, by: `m:${ana.id}` } },
    ],
    more: false,
  });

  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "Typed after the snap", replace: "Typed after the snap, and kept" }],
  });
  expect(edited).not.toHaveProperty("error");
  const saved = `${first}\n\nDraft ${STORAGE_LIVE_SNAP_EVERY}\n\nTyped after the snap, and kept`;
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(saved);
  const fold = await tab.waitFor(
    (e) => e.type === "doc.record" && (e.record as Event).t === "fold",
  );
  expect(fold.record).toMatchObject({ t: "fold", e: epoch, cv: 2 });
  tab.socket.close();
});

test("a snap of an older epoch that lands after a newer seed does not hide the newer epoch's typing", async () => {
  const org = await stack.company(`late-snap-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes("# Plan\n\nOld"));
  const saved = await call(agent, "drive_edit_doc", { id: doc.id, markdown: "# Plan\n\nNew" });
  expect(saved).not.toHaveProperty("error");
  const tab = await editor(ana.jar, doc.id);

  const stale = new Y.Doc();
  const old = await tab.append(
    { t: "seed", cv: 1, u: base64(rewriteLive(stale, "# Plan\n\nOld")) },
    0,
  );
  const typing = new Y.Doc();
  const epoch = await tab.append({
    t: "seed",
    cv: 2,
    u: base64(rewriteLive(typing, "# Plan\n\nNew")),
  });
  const late = {
    t: "snap",
    e: old,
    s: old,
    cv: 1,
    f: old,
    u: base64(Y.encodeStateAsUpdate(stale)),
  };
  await tab.append(late);
  const typed = "# Plan\n\nNew, typed live";
  await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(typing, typed)) });

  const opened = await stack.api(ana.jar, "GET", `/files/${doc.id}/live?from=latest`);
  expect(opened.body.entries[0]).toMatchObject({ seqNum: epoch, record: { t: "seed", cv: 2 } });
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "typed live", replace: "typed live, kept" }],
  });
  expect(edited).not.toHaveProperty("error");
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(`${typed}, kept`);
  tab.socket.close();
});

test("an agent reads a doc as people see it, unsaved typing included, and each version with who wrote it", async () => {
  const org = await stack.company(`agents-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const first = "# Plan\n\nStep one";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(first));
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "Step one", replace: "Step one, booked" }],
  });
  expect(edited).not.toHaveProperty("error");

  const tab = await editor(ana.jar, doc.id);
  const typing = new Y.Doc();
  const saved = "# Plan\n\nStep one, booked";
  const epoch = await tab.append({ t: "seed", cv: 2, u: base64(rewriteLive(typing, saved)) }, 0);
  await tab.append({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(typing, `${saved}\n\nStep two`)),
  });

  const fetched = await call(agent, "drive_fetch", { id: doc.id });
  expect(fetched).toMatchObject({
    text: `${saved}\n\nStep two`,
    metadata: { unsaved_edits: true, text_status: "ok" },
  });
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(saved);

  const listed = await call(agent, "drive_versions", { id: doc.id });
  expect(listed).toMatchObject({
    current: { id: "current", written_by: expect.any(String), agent: "Drive agent" },
    versions: [{ agent: null, size: first.length }],
    keep_days: 30,
  });
  const [version] = (listed as { versions: { id: string }[] }).versions;
  const read = await call(agent, "drive_versions", { id: doc.id, version_id: version!.id });
  expect(read).toMatchObject({ text: first, truncated: false, version: { id: version!.id } });
  const { diff } = read as { diff: string };
  expect(diff.startsWith("--- version\n+++ current\n@@ -1,3 +1,3 @@\n")).toBe(true);
  expect(diff).toContain("\n-Step one\n");
  expect(diff).toContain("\n+Step one, booked\n");

  const missing = await call(agent, "drive_versions", { id: doc.id, version_id: "nope" });
  expect(missing).toHaveProperty("error");
  tab.socket.close();
});

test("versions too different to diff answer with the version's text instead of running out of time", async () => {
  const org = await stack.company(`big-diff-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const lines = (prefix: string) =>
    Array.from({ length: 6_000 }, (_, i) => `${prefix}${i}`).join("\n");
  const doc = await stack.upload(ana.jar, { space: "shared" }, "log.md", bytes(lines("a")));
  expect(
    await call(agent, "drive_edit_doc", { id: doc.id, markdown: lines("b") }),
  ).not.toHaveProperty("error");

  const listed = await call(agent, "drive_versions", { id: doc.id });
  const [version] = (listed as { versions: { id: string }[] }).versions;
  const read = await call(agent, "drive_versions", {
    id: doc.id,
    version_id: version!.id,
    max_chars: 200_000,
  });
  expect(read).toMatchObject({ diff: "", diff_too_large: true, truncated: false });
  expect((read as { text: string }).text).toBe(lines("a"));
});

test("a version restored while people edit is an edit of their live document: they see it, and their next save is not refused", async () => {
  const org = await stack.company(`restore-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const first = "# Plan\n\nFirst draft";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes(first));
  const second = "# Plan\n\nSecond draft";
  expect(await call(agent, "drive_edit_doc", { id: doc.id, markdown: second })).not.toHaveProperty(
    "error",
  );
  const listed = await stack.api(ana.jar, "GET", `/files/${doc.id}/versions`);
  const [kept] = listed.body.versions as { id: string; size: number }[];
  expect(kept!.size).toBe(first.length);

  const tab = await editor(ana.jar, doc.id);
  const typing = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 2, u: base64(rewriteLive(typing, second)) }, 0);
  await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(typing, `${second}, typed`)) });

  const restored = await stack.api(
    ana.jar,
    "POST",
    `/files/${doc.id}/versions/${kept!.id}/restore`,
  );
  expect(restored.status).toBe(200);
  expect(restored.body.node.contentVersion).toBe(3);
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(first);
  const heard = (await tab.waitFor(
    (e) =>
      e.type === "doc.record" &&
      (e.record as Event).t === "update" &&
      (e.record as Event).by === `m:${ana.id}`,
  )) as { record: { u: string } };
  Y.applyUpdate(typing, Buffer.from(heard.record.u, "base64"));
  await tab.waitFor((e) => e.type === "doc.record" && (e.record as Event).t === "fold");

  const after = `${first}, and more`;
  await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(typing, after)) });
  const saved = await stack.api(ana.jar, "POST", `/files/${doc.id}/versions`, {
    size: bytes(after).length,
    mimeType: "text/markdown",
    ifContentVersion: 3,
  });
  expect(saved.status).toBe(201);
  tab.socket.close();
});

const paragraphs = (words: string) =>
  Array.from({ length: 560 }, (_, i) => `${i} ${words.repeat(130)}`).join("\n\n");

test("a document too large for one record goes through in parts: a split seed opens, a split paste reaches an agent's edit whole, and a split snap missing a part is passed over", async () => {
  const org = await stack.company(`parts-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = `# Long\n\n${paragraphs("lorem ipsum ")}`;
  const doc = await stack.upload(ana.jar, { space: "shared" }, "long.md", bytes(first));
  const tab = await editor(ana.jar, doc.id);

  const typing = new Y.Doc();
  const seed = splitLiveRecord({ t: "seed", cv: 1, u: base64(rewriteLive(typing, first)) });
  expect(seed.head.n).toBeGreaterThan(1);
  const epoch = await tab.append(seed.head, 0);
  for (const part of seed.rest(epoch)) await tab.append(part);

  const pasted = `# Long\n\n${paragraphs("dolor sitam ")}\n\nTyped by Ana`;
  const paste = splitLiveRecord({ t: "update", e: epoch, u: base64(rewriteLive(typing, pasted)) });
  expect(paste.head.n).toBeGreaterThan(1);
  const pasteAt = await tab.append(paste.head);
  let last = pasteAt;
  for (const part of paste.rest(pasteAt)) last = await tab.append(part);

  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "Typed by Ana", replace: "Typed by Ana, kept by the agent" }],
  });
  expect(edited).not.toHaveProperty("error");
  const saved = pasted.replace("Typed by Ana", "Typed by Ana, kept by the agent");
  expect(await (await stack.download(ana.jar, doc.id)).text()).toBe(saved);

  const fold = await tab.waitFor(
    (e) => e.type === "doc.record" && (e.record as Event).t === "fold",
  );
  const joiner = new LiveParts();
  for (const e of tab.received.filter((event) => event.type === "doc.record")) {
    const whole = joiner.push({ seqNum: e.seqNum, record: e.record } as StorageLiveEntry);
    if (whole?.record.t === "update") Y.applyUpdate(typing, Buffer.from(whole.record.u, "base64"));
  }
  expect(liveMarkdown(typing)).toBe(saved);

  const snap = splitLiveRecord({
    t: "snap",
    e: epoch,
    s: fold.seqNum as number,
    cv: 2,
    f: last,
    u: base64(Y.encodeStateAsUpdate(typing)),
  });
  expect(snap.head.n).toBeGreaterThan(1);
  await tab.append(snap.head);
  const opened = await stack.api(ana.jar, "GET", `/files/${doc.id}/live?from=latest`);
  const entries = (opened.body as { entries: StorageLiveEntry[] }).entries;
  expect(entries[0]).toMatchObject({ seqNum: epoch, record: { t: "seed", n: seed.head.n } });

  const after = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "kept by the agent", replace: "kept by the agent, twice" }],
  });
  expect(after).not.toHaveProperty("error");
  const reread = await call(agent, "drive_fetch", { id: doc.id });
  expect((reread as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty(
    "unsaved_edits",
  );
  tab.socket.close();
});

test("an agent's edit that fit one record before parts still goes as one, and a split change finished after a save still reads as unsaved", async () => {
  const org = await stack.company(`one-record-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Notes\n\nShort";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes(first));
  const tab = await editor(ana.jar, doc.id);
  const typing = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(typing, first)) }, 0);

  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const long = "x".repeat(610_000);
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "Short", replace: long }],
  });
  expect(edited).not.toHaveProperty("error");
  const heard = await tab.waitFor(
    (e) => e.type === "doc.record" && (e.record as Event).t === "update",
  );
  expect((heard.record as Event).n).toBeUndefined();
  await tab.waitFor((e) => e.type === "doc.record" && (e.record as Event).t === "fold");
  Y.applyUpdate(typing, Buffer.from((heard.record as { u: string }).u, "base64"));
  expect(liveMarkdown(typing)).toBe(`# Notes\n\n${long}`);

  const pasted = `# Notes\n\n${paragraphs("dolor sitam ")}`;
  const paste = splitLiveRecord({ t: "update", e: epoch, u: base64(rewriteLive(typing, pasted)) });
  expect(paste.head.n).toBeGreaterThan(1);
  const head = await tab.append(paste.head);
  const between = await tab.append({
    t: "update",
    e: epoch,
    u: base64(Y.encodeStateAsUpdate(new Y.Doc())),
  });
  await tab.append({ t: "fold", e: epoch, cv: 2, s: between });
  for (const part of paste.rest(head)) await tab.append(part);

  const fetched = await call(agent, "drive_fetch", { id: doc.id });
  expect(fetched).toMatchObject({ metadata: { unsaved_edits: true } });
  expect((fetched as { text: string }).text.startsWith("# Notes\n\n0 dolor sitam")).toBe(true);

  const stalled = splitLiveRecord({
    t: "update",
    e: epoch,
    u: base64(rewriteLive(typing, `${pasted}\n\n${paragraphs("amet elit ")}`)),
  });
  await tab.append(stalled.head);
  const [zero, one] = await Promise.all([
    call(agent, "drive_edit_doc", {
      id: doc.id,
      edits: [{ find: "\n\n0 dolor", replace: "\n\nZero dolor" }],
    }),
    call(agent, "drive_edit_doc", {
      id: doc.id,
      edits: [{ find: "\n\n1 dolor", replace: "\n\nOne dolor" }],
    }),
  ]);
  expect(zero).not.toHaveProperty("error");
  expect(one).not.toHaveProperty("error");
  const both = await (await stack.download(ana.jar, doc.id)).text();
  expect(both).toContain("Zero dolor");
  expect(both).toContain("One dolor");
  tab.socket.close();
});

test("a record too large to share a read with the small ones before it still opens with them", async () => {
  const org = await stack.company(`cut-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const first = "# Notes\n\nStart";
  const doc = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes(first));
  const tab = await editor(ana.jar, doc.id);
  const typing = new Y.Doc();
  const epoch = await tab.append({ t: "seed", cv: 1, u: base64(rewriteLive(typing, first)) }, 0);
  let text = first;
  for (let i = 0; i < 35; i++) {
    text += `\n\n${i} ${"typed ".repeat(330)}`;
    await tab.append({ t: "update", e: epoch, u: base64(rewriteLive(typing, text)) });
  }
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const long = "x".repeat(730_000);
  const edited = await call(agent, "drive_edit_doc", {
    id: doc.id,
    edits: [{ find: "Start", replace: long }],
  });
  expect(edited).not.toHaveProperty("error");

  const opened = await stack.api(ana.jar, "GET", `/files/${doc.id}/live?from=latest`);
  const { entries } = opened.body as { entries: StorageLiveEntry[] };
  expect(entries.map((e) => e.record.t)).toEqual(["seed", ...Array(36).fill("update"), "fold"]);
  const big = entries.at(-2)!.record as { u: string; n?: number };
  expect(big.n).toBeUndefined();
  expect(big.u.length).toBeGreaterThan(950_000);
  const next = `/files/${doc.id}/live?from=${entries.at(-1)!.seqNum + 1}`;
  expect((await stack.api(ana.jar, "GET", next)).body).toMatchObject({ entries: [], more: false });
  Y.applyUpdate(typing, Buffer.from(big.u, "base64"));
  expect(liveMarkdown(typing)).toBe(text.replace("Start", long));
  tab.socket.close();
});

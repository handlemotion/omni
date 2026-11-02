// Runs every member read and hot writer against the `perf:seed` database, captures the SQL each
// one sends, and prints `EXPLAIN (ANALYZE, BUFFERS)` numbers per call: queries sent, summed
// execution time (median of 5), buffers touched, and any sequential scan of a big table.
// Writers run inside a transaction that is rolled back, so the seed stays put between runs.
//
//   pnpm --filter @omni/db perf:explain                  # summary table
//   pnpm --filter @omni/db perf:explain -- --plans out/  # also writes each text plan to out/
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createDb, type Db } from "../src/client.ts";
import { readDatabaseUrl } from "../src/env.ts";
import {
  addLocation,
  claimActions,
  enqueueAction,
  findMemberAttachmentByHash,
  findThreadByMessageIds,
  folderLocations,
  forMember,
  hasLocation,
  listMemberMailboxes,
  loadThreadForAi,
  mailboxAudience,
  removeLocations,
  saveTriage,
  setLocationFlags,
  setThreadArchived,
  subjectThreadCandidates,
  threadActionTargets,
  threadsByMessageIds,
  upsertMessage,
} from "../src/index.ts";

const RUNS = 5;
const BIG_TABLES = new Set([
  "threads",
  "messages",
  "message_locations",
  "attachments",
  "thread_state",
  "mail_actions",
]);

const dbName = process.env.PERF_DATABASE ?? "omni_perf";
const plansDir = process.argv.includes("--plans")
  ? process.argv[process.argv.indexOf("--plans") + 1]!
  : null;
const url = new URL(readDatabaseUrl(join(import.meta.dirname, "..")));
url.pathname = `/${dbName}`;

let captured: { query: string; params: unknown[] }[] = [];
const { db, close } = createDb(url.toString(), {
  max: 1,
  onnotice: () => {},
  debug: (_conn, query, params) => captured.push({ query, params: params as unknown[] }),
});
const raw = postgres(url.toString(), { max: 1, onnotice: () => {} });

// Fixtures: two members at the ends of the spread (one sees all 12 org1 mailboxes, one sees 2),
// the busiest mailbox, a typical and the longest thread.
const one = async <T>(q: Promise<T[]>) => (await q)[0]!;
const memberAll = "member-org1-1";
const memberFew = "member-org1-8";
const box = await one(
  raw<{ id: string; orgId: string }[]>`
    select m.id, m.org_id as "orgId" from mailboxes m join threads t on t.mailbox_id = m.id
    group by m.id order by count(*) desc limit 1`,
);
const inbox = await one(
  raw<
    { id: string }[]
  >`select id from mailbox_folders where mailbox_id = ${box.id} and path = 'INBOX'`,
);
const typical = await one(
  raw<{ id: string; subjectKey: string }[]>`
    select t.id, t.subject_key as "subjectKey" from threads t
    join messages m on m.thread_id = t.id where t.mailbox_id = ${box.id}
    group by t.id having count(*) = 3 order by t.last_message_at desc limit 1`,
);
const longest = await one(
  raw<
    { id: string }[]
  >`select thread_id as id from messages group by 1 order by count(*) desc limit 1`,
);
const deepCursor = await one(
  raw<{ lastMessageAt: Date; id: string }[]>`
    select t.last_message_at as "lastMessageAt", t.id from threads t
    join mailbox_access a on a.mailbox_id = t.mailbox_id and a.member_id = ${memberAll}
    where not t.archived order by t.last_message_at desc, t.id desc offset 2000 limit 1`,
);
const headers = (
  await raw<{ h: string }[]>`
    select message_id_header as h from messages where mailbox_id = ${box.id} limit 3`
).map((r) => r.h);
const attachment = await one(
  raw<{ sha: string }[]>`
    select split_part(a.r2_key, '/att/', 2) as sha from attachments a
    join messages m on m.id = a.message_id where m.mailbox_id = ${box.id}
    order by a.id desc limit 1`,
);
const rareToken = await one(
  raw<{ token: string }[]>`
    select substring(clean_text from 'INV[0-9]+') as token from messages
    where mailbox_id = ${box.id} and clean_text like '%INV%' limit 1`,
);
const typicalMessage = await one(
  raw<{ id: string }[]>`select id from messages where thread_id = ${typical.id} limit 1`,
);
const inboxUids = (
  await raw<{ uid: number }[]>`
    select imap_uid::int as uid from message_locations where folder_id = ${inbox.id}
    order by imap_uid desc limit 50`
).map((r) => r.uid);

const all = forMember(db, memberAll);
const few = forMember(db, memberFew);
const rollback = new Error("rollback");

type Case = { name: string; write?: boolean; run: (db: Db) => Promise<unknown> };
const cases: Case[] = [
  { name: "listThreads inbox (12 boxes)", run: () => all.listThreads() },
  { name: "listThreads inbox (2 boxes)", run: () => few.listThreads() },
  { name: "listThreads inbox one mailbox", run: () => all.listThreads({ mailboxId: box.id }) },
  { name: "listThreads archive (all mail)", run: () => all.listThreads({ view: "archive" }) },
  { name: "listThreads snoozed", run: () => all.listThreads({ view: "snoozed" }) },
  { name: "counts (12 boxes)", run: () => all.counts() },
  { name: "listThreads page 41 (cursor)", run: () => all.listThreads({ before: deepCursor }) },
  { name: "listThreads lane needs_reply", run: () => all.listThreads({ lane: "needs_reply" }) },
  { name: "listThreads lane unsure", run: () => all.listThreads({ lane: "unsure" }) },
  {
    name: "listThreads lane fyi one mailbox",
    run: () => all.listThreads({ lane: "fyi", mailboxId: box.id }),
  },
  { name: "getThread (3 messages)", run: () => all.getThread(typical.id) },
  { name: "getThread (longest thread)", run: () => all.getThread(longest.id) },
  { name: "search common word", run: () => all.search("meeting") },
  { name: "search medium word", run: () => all.search("harbor") },
  { name: "search rare token", run: () => all.search(rareToken.token) },
  { name: "search no match", run: () => all.search("zyzzyva") },
  { name: "search two words", run: () => all.search("harbor glacier") },
  { name: "search medium, 2 boxes", run: () => few.search("harbor") },
  { name: "search medium, one mailbox", run: () => all.search("harbor", { mailboxId: box.id }) },
  {
    name: "setThreadState",
    write: true,
    run: (tx) => forMember(tx, memberAll).setThreadState(typical.id, { read: false }),
  },
  { name: "listMemberMailboxes", run: () => listMemberMailboxes(db, memberAll) },
  { name: "threadActionTargets", run: () => threadActionTargets(db, memberAll, typical.id) },
  {
    name: "setThreadArchived",
    write: true,
    run: (tx) => setThreadArchived(tx, memberAll, typical.id, true),
  },
  {
    name: "findMemberAttachmentByHash",
    run: () => findMemberAttachmentByHash(db, memberAll, attachment.sha),
  },
  { name: "findThreadByMessageIds", run: () => findThreadByMessageIds(db, box.id, headers) },
  { name: "threadsByMessageIds", run: () => threadsByMessageIds(db, box.id, headers) },
  {
    name: "subjectThreadCandidates",
    run: () =>
      subjectThreadCandidates(db, {
        mailboxId: box.id,
        subjectKey: typical.subjectKey,
        since: new Date(Date.now() - 90 * 86_400_000),
      }),
  },
  {
    name: "upsertMessage (new, in thread)",
    write: true,
    run: (tx) =>
      upsertMessage(tx, {
        orgId: box.orgId,
        mailboxId: box.id,
        threadId: typical.id,
        messageIdHeader: `<perf-${Date.now()}@omni.test>`,
        subject: "Re: perf",
        fromAddress: "perf@example.test",
        sentAt: new Date(),
        cleanText: "perf run message body",
        attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 1, r2Key: "k" }],
      }),
  },
  {
    name: "addLocation",
    write: true,
    run: (tx) =>
      addLocation(tx, {
        orgId: box.orgId,
        mailboxId: box.id,
        folderId: inbox.id,
        uid: 10_000_000,
        messageId: typicalMessage.id,
        flags: [],
        modseq: null,
      }),
  },
  { name: "folderLocations (busiest INBOX)", run: () => folderLocations(db, box.id, "INBOX") },
  { name: "hasLocation", run: () => hasLocation(db, box.id, "INBOX", inboxUids[0]!) },
  {
    name: "setLocationFlags (50)",
    write: true,
    run: (tx) =>
      setLocationFlags(tx, {
        mailboxId: box.id,
        path: "INBOX",
        changes: inboxUids.map((uid) => ({ uid, flags: ["\\Seen"], modseq: null })),
      }),
  },
  {
    name: "removeLocations (50)",
    write: true,
    run: (tx) => removeLocations(tx, { mailboxId: box.id, path: "INBOX", uids: inboxUids }),
  },
  { name: "claimActions", write: true, run: (tx) => claimActions(tx) },
  {
    name: "enqueueAction",
    write: true,
    run: (tx) =>
      enqueueAction(tx, {
        orgId: box.orgId,
        mailboxId: box.id,
        memberId: null,
        kind: "archive",
        payload: {},
        idempotencyKey: `perf-${Date.now()}`,
      }),
  },
  { name: "loadThreadForAi", run: () => loadThreadForAi(db, typical.id) },
  {
    name: "saveTriage",
    write: true,
    run: (tx) => saveTriage(tx, typical.id, { bucket: "fyi", confidence: 0.9 }),
  },
  { name: "mailboxAudience", run: () => mailboxAudience(db, [box.id]) },
];

const only = process.env.PERF_ONLY;
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}
const seqScans = (node: PlanNode, out: string[] = []) => {
  if (node["Node Type"] === "Seq Scan" && BIG_TABLES.has(node["Relation Name"] ?? "")) {
    out.push(node["Relation Name"]!);
  }
  for (const child of node.Plans ?? []) seqScans(child, out);
  return out;
};

type Explained = { json: Record<string, unknown>[]; text: Record<string, unknown>[] };

// Explains a call's queries in order. A writer's queries depend on each other (an insert, then
// rows referencing it), so they run in one transaction that is rolled back.
const explainAll = async (queries: { query: string; params: unknown[] }[], write: boolean) => {
  const run = async (
    sql: postgres.Sql | postgres.TransactionSql,
    query: string,
    params: unknown[],
  ) => {
    const exec = (format: string) =>
      sql.unsafe(
        `explain (analyze, buffers, format ${format}) ${query}`,
        params as postgres.ParameterOrJSON<never>[],
      ) as unknown as Promise<Record<string, unknown>[]>;
    return { json: await exec("json"), text: await exec("text") };
  };
  if (!write) {
    const out: Explained[] = [];
    for (const q of queries) out.push(await run(raw, q.query, q.params));
    return out;
  }
  const out: Explained[] = [];
  await raw
    .begin(async (tx) => {
      // Text and JSON both execute the statement; the savepoint undoes the first execution.
      for (const q of queries) {
        await tx.unsafe("savepoint e");
        const json = (await tx.unsafe(
          `explain (analyze, buffers, format json) ${q.query}`,
          q.params as postgres.ParameterOrJSON<never>[],
        )) as unknown as Record<string, unknown>[];
        await tx.unsafe("rollback to savepoint e");
        const text = (await tx.unsafe(
          `explain (analyze, buffers, format text) ${q.query}`,
          q.params as postgres.ParameterOrJSON<never>[],
        )) as unknown as Record<string, unknown>[];
        out.push({ json, text });
      }
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
  return out;
};

if (plansDir) mkdirSync(plansDir, { recursive: true });
console.log(
  `${"case".padEnd(34)} ${"q".padStart(3)} ${"exec ms".padStart(9)} ${"wall ms".padStart(9)} ${"buffers".padStart(9)}  seq scans`,
);
for (const c of cases) {
  if (only && !c.name.includes(only)) continue;
  const call = async () => {
    if (!c.write) return c.run(db);
    return db
      .transaction(async (tx) => {
        await c.run(tx as unknown as Db);
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
  };
  await call(); // warm
  const walls: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    captured = [];
    const started = performance.now();
    await call();
    walls.push(performance.now() - started);
  }
  const queries = captured.filter(
    (q) => !/^(begin|commit|rollback|savepoint|release)/i.test(q.query),
  );

  const runs: Explained[][] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await explainAll(queries, c.write ?? false));
  let exec = 0;
  let buffers = 0;
  const scans: string[] = [];
  const texts: string[] = [];
  queries.forEach(({ query, params }, i) => {
    const plans = runs.map(
      (r) => (r[i]!.json[0]!["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[])[0]!,
    );
    const last = runs.at(-1)![i]!;
    exec += median(plans.map((p) => p["Execution Time"]));
    const root = plans.at(-1)!.Plan;
    buffers += (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
    scans.push(...seqScans(root));
    texts.push(
      `-- ${query}\n-- params: ${JSON.stringify(params)}\n${last.text.map((r) => r["QUERY PLAN"]).join("\n")}`,
    );
  });
  console.log(
    `${c.name.padEnd(34)} ${String(queries.length).padStart(3)} ${exec.toFixed(2).padStart(9)} ${median(walls).toFixed(2).padStart(9)} ${String(buffers).padStart(9)}  ${[...new Set(scans)].join(", ")}`,
  );
  if (plansDir) {
    writeFileSync(
      join(plansDir, `${c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.txt`),
      texts.join("\n\n"),
    );
  }
}

await close();
await raw.end();

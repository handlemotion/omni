// Seeds a throwaway database with inbox-scale mail for `EXPLAIN (ANALYZE, BUFFERS)` work:
// 3 orgs, 20 mailboxes, 60k threads, 200k messages, their IMAP copies, attachments, per-member
// read state and an outbox history. Rows are generated in Postgres, so a full seed takes about a
// minute. Never point this at a shared database: it drops and recreates `PERF_DATABASE`.
//
//   pnpm db:local:up
//   pnpm --filter @omni/db perf:seed            # DATABASE_URL is the admin connection
//
// Sizes are tunable: PERF_THREADS, PERF_MESSAGES. The data is skewed like real mail: a few busy
// mailboxes, recent mail denser than old, most old threads archived, a long tail of long threads.
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "../src/client.ts";
import { readDatabaseUrl } from "../src/env.ts";

const dbName = process.env.PERF_DATABASE ?? "omni_perf";
const threadCount = Number(process.env.PERF_THREADS ?? 60_000);
const messageCount = Number(process.env.PERF_MESSAGES ?? 200_000);
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`bad PERF_DATABASE: ${dbName}`);
if (messageCount < threadCount) throw new Error("PERF_MESSAGES must be >= PERF_THREADS");

const adminUrl = readDatabaseUrl(fileURLToPath(new URL("..", import.meta.url)));
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
await admin.unsafe(`drop database if exists ${dbName} with (force)`);
await admin.unsafe(`create database ${dbName}`);
await admin.end();

const { db, close } = createDb(url.toString(), { onnotice: () => {} });
await migrate(db, {
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
});
await close();

const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const step = async (label: string, query: string) => {
  const started = performance.now();
  await sql.unsafe(query);
  console.log(`${label.padEnd(24)} ${Math.round(performance.now() - started)} ms`);
};

// Zipf-ish vocabulary: power(random(), 3) picks low indexes far more often, so early words are
// common ("meeting", in a large share of messages) and late ones rare, like real text.
const words = `meeting thanks please update project team review invoice payment schedule call
  week today tomorrow monday friday report draft contract proposal budget design launch customer
  order shipping delivery account access password reset login release deploy server database
  error issue ticket support question answer follow agenda notes minutes slides deck quarter
  revenue forecast hiring candidate interview offer onboarding vacation travel flight hotel
  booking receipt subscription renewal trial discount pricing quote estimate approval signature
  legal policy privacy security audit compliance backup migration roadmap milestone sprint
  feedback survey newsletter webinar event conference workshop partner vendor supplier
  warehouse inventory refund return complaint escalation outage incident postmortem metrics
  dashboard analytics marketing campaign social press media brand logo website domain email
  calendar invite reminder deadline urgent asap blocked waiting pending confirmed cancelled
  rescheduled lunch coffee dinner birthday congratulations welcome goodbye intro referral
  photography wedding portfolio gallery print album lighting studio session edit retouch
  frame canvas exhibit catalogue shipment customs tariff freight pallet container harbor
  pumpkin lantern orchard harvest cider glacier fjord tundra aurora basalt obsidian quartz`
  .split(/\s+/)
  .filter(Boolean);
const vocab = `array[${words.map((w) => `'${w}'`).join(",")}]`;
const word = `(${vocab})[1 + floor(power(random(), 3) * ${words.length})::int]`;

await step(
  "setup",
  `
  select setseed(0.42);
  insert into organizations (id, name, slug, created_at)
    select 'org' || o, 'Org ' || o, 'org-' || o, now() from generate_series(1, 3) o;
  -- 20 mailboxes: 12 in org1, 5 in org2, 3 in org3.
  create table seed_mailboxes as
    select n, uuidv7()::text as id,
      case when n <= 12 then 'org1' when n <= 17 then 'org2' else 'org3' end as org_id
    from generate_series(1, 20) n;
  insert into mailboxes (id, org_id, address, kind, credentials_enc, status)
    select id, org_id, 'box' || n || '@' || org_id || '.test',
      case when n % 3 = 0 then 'personal' else 'shared' end::mailbox_kind, 'seed', 'active'
    from seed_mailboxes;
  insert into mailbox_folders (id, org_id, mailbox_id, path, role, uidvalidity, uidnext)
    select uuidv7()::text, b.org_id, b.id, f.path, f.role::folder_role, 1, 1
    from seed_mailboxes b,
      (values ('INBOX', 'inbox'), ('Sent', 'sent'), ('Archive', 'archive')) f(path, role);
  -- Members: 8 in org1, 4 in org2, 2 in org3. Member 1 of each org sees every org mailbox; the
  -- others see the mailboxes whose number lands on them, so most see two or three.
  create table seed_members as
    select o.org_id, m, 'member-' || o.org_id || '-' || m as id
    from (values ('org1', 8), ('org2', 4), ('org3', 2)) o(org_id, k), generate_series(1, o.k) m;
  insert into users (id, name, email, email_verified, created_at, updated_at)
    select 'user-' || id, id, id || '@seed.test', true, now(), now() from seed_members;
  insert into members (id, organization_id, user_id, role, created_at)
    select id, org_id, 'user-' || id, case when m = 1 then 'owner' else 'member' end, now()
    from seed_members;
  insert into mailbox_access (org_id, mailbox_id, member_id, role)
    select b.org_id, b.id, s.id, case when s.m = 1 then 'owner' else 'member' end::mailbox_access_role
    from seed_mailboxes b
    join seed_members s on s.org_id = b.org_id
    join (select org_id, count(*) k from seed_members group by org_id) c on c.org_id = b.org_id
    where s.m = 1 or (b.n % c.k) + 1 = s.m or (b.n % (c.k - 1)) + 2 = s.m;
`,
);

await step(
  "threads",
  `
  select setseed(0.43);
  create table seed_threads as
    select n,
      uuidv7()::text as id,
      -- power(random(), 2) skews toward low mailbox numbers: box 1 gets about a fifth of all mail.
      1 + floor(power(random(), 2) * 20)::int as box,
      now() - (power(random(), 2) * interval '1095 days') as last_at,
      initcap(${word}) || ' ' || ${word} || ' ' || ${word} || ' ' || ${word} as subject,
      'person' || floor(random() * 5000)::int || '@' ||
        (array['acme.test','globex.test','initech.test','umbrella.test','example.test'])[1 + floor(random() * 5)::int] as counterparty,
      random() as r
    from generate_series(1, ${threadCount}) n;
  alter table seed_threads add primary key (n);
  insert into threads (id, org_id, mailbox_id, subject_key, last_message_at, archived,
                       triage, triage_confidence, triage_source)
    select t.id, b.org_id, b.id, lower(t.subject), t.last_at,
      -- Mail older than two weeks is mostly archived.
      t.last_at < now() - interval '14 days' and t.r > 0.1,
      case when t.r < 0.75 then (array['needs_reply','waiting_on_them','fyi','noise'])[1 + floor(random() * 4)::int]::triage_bucket end,
      case when t.r < 0.72 then 0.5 + random() * 0.5 when t.r < 0.75 then 1 end,
      case when t.r < 0.72 then 'ai' when t.r < 0.75 then 'person' end::triage_source
    from seed_threads t join seed_mailboxes b on b.n = t.box;
`,
);

await step(
  "messages",
  `
  select setseed(0.44);
  -- Every thread gets one message; the rest go to a long tail (power 3 favors low thread numbers).
  create table seed_messages as
    select g as n, uuidv7()::text as id,
      case when g <= ${threadCount} then g else 1 + floor(power(random(), 3) * ${threadCount})::int end as thread_n,
      random() < 0.12 as from_us,
      random() as r,
      random() * interval '20 days' as age
    from generate_series(1, ${messageCount}) g;
  insert into messages (id, org_id, mailbox_id, thread_id, message_id_header, in_reply_to,
                        "references", subject, from_name, from_address, "to", cc, sent_at,
                        r2_key, clean_text)
    select m.id, b.org_id, b.id, t.id,
      '<' || m.n || '.seed@omni.test>',
      case when m.n > ${threadCount} then '<' || m.thread_n || '.seed@omni.test>' end,
      case when m.n > ${threadCount} then array['<' || m.thread_n || '.seed@omni.test>'] else '{}' end,
      case when m.n > ${threadCount} then 'Re: ' else '' end || t.subject,
      case when m.from_us then 'Box ' || b.n else initcap(split_part(t.counterparty, '@', 1)) end,
      case when m.from_us then 'box' || b.n || '@' || b.org_id || '.test' else t.counterparty end,
      jsonb_build_array(jsonb_build_object('name', null, 'address',
        case when m.from_us then t.counterparty else 'box' || b.n || '@' || b.org_id || '.test' end)),
      '[]'::jsonb,
      case when m.n <= ${threadCount} then t.last_at else t.last_at - m.age end,
      b.org_id || '/' || b.id || '/raw/' || md5(m.id) || '.eml',
      -- 40 to 160 words; one in ten carries a rare invoice number for selective searches.
      array_to_string(array(
        select ${word} from generate_series(1, 40 + (m.n * 7919) % 120) where m.n is not null
      ), ' ') || case when m.r < 0.1 then ' invoice INV' || (m.n * 31) % 100000 else '' end
    from seed_messages m
    join seed_threads t on t.n = m.thread_n
    join seed_mailboxes b on b.n = t.box;
`,
);

await step(
  "locations",
  `
  select setseed(0.45);
  -- Each message lives in Sent (ours), INBOX (thread not archived) or Archive, with UIDs in
  -- sent order per folder.
  with placed as (
    select m.id, m.org_id, m.mailbox_id, m.sent_at, f.id as folder_id
    from messages m
    join threads t on t.id = m.thread_id
    join mailbox_folders f on f.mailbox_id = m.mailbox_id and f.path =
      case when m.from_address like 'box%' then 'Sent' when t.archived then 'Archive' else 'INBOX' end
  ), numbered as (
    select *, row_number() over (partition by folder_id order by sent_at, id) as uid from placed
  ), loc as (
    insert into message_locations (org_id, mailbox_id, folder_id, imap_uid, message_id, flags)
      select org_id, mailbox_id, folder_id, uid, id,
        case when random() < 0.7 then array['\\Seen'] else '{}' end
      from numbered
      returning folder_id, imap_uid, message_id
  )
  update messages m set folder_id = loc.folder_id, imap_uid = loc.imap_uid
    from loc where m.id = loc.message_id;
  update mailbox_folders f set uidnext = coalesce(
    (select max(imap_uid) + 1 from message_locations l where l.folder_id = f.id), 1);
`,
);

await step(
  "attachments",
  `
  select setseed(0.46);
  insert into attachments (id, org_id, message_id, filename, mime_type, size, r2_key)
    select uuidv7()::text, m.org_id, m.id, 'file-' || left(md5(m.id), 6) || '.pdf',
      'application/pdf', 1000 + floor(random() * 2000000)::int,
      m.org_id || '/' || m.mailbox_id || '/att/' || encode(sha256(convert_to(m.id, 'UTF8')), 'hex')
    from messages m where random() < 0.1;
`,
);

await step(
  "thread_state",
  `
  select setseed(0.47);
  -- Each member has opened about 60% of the threads they can see, and snoozed 1% of those.
  insert into thread_state (org_id, thread_id, member_id, read, snoozed_until)
    select t.org_id, t.id, a.member_id, true,
      case when random() < 0.01 then now() + interval '3 days' end
    from threads t join mailbox_access a on a.mailbox_id = t.mailbox_id
    where random() < 0.6;
`,
);

await step(
  "mail_actions",
  `
  select setseed(0.48);
  -- A long done history and a handful due now, as the claim loop sees it.
  insert into mail_actions (id, org_id, mailbox_id, member_id, kind, payload, idempotency_key,
                            status, attempts, run_after, completed_at, created_at)
    select uuidv7()::text, b.org_id, b.id, null,
      (array['send','archive','mark_read','move'])[1 + floor(random() * 4)::int]::mail_action_kind,
      '{}'::jsonb, 'seed-' || g,
      case when g <= 20 then 'pending' else 'done' end::mail_action_status,
      1, now() - (g * interval '1 minute'),
      case when g > 20 then now() - (g * interval '1 minute') end,
      now() - (g * interval '1 minute')
    from generate_series(1, 30000) g
    join seed_mailboxes b on b.n = 1 + g % 20;
`,
);

await step("cleanup", "drop table seed_mailboxes, seed_members, seed_threads, seed_messages");
await step("vacuum analyze", "vacuum analyze");

const [counts] = await sql`
  select (select count(*) from threads) as threads, (select count(*) from messages) as messages,
    (select count(*) from message_locations) as locations, (select count(*) from attachments) as attachments,
    (select count(*) from thread_state) as thread_state, pg_size_pretty(pg_database_size(current_database())) as size`;
console.log(counts);
await sql.end();

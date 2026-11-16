# 0036: CRM, a client layer inside every company workspace

Date: 2026-11-16 · Status: accepted · Amends: spec v1 "Non-goals" (contacts), ADR 0034
(Storage gains a file lock), AGENTS.md "Postgres is an index Purelymail can rebuild" (for this
module only) · Builds on: ADR 0035

## Context

A company that runs its mail and files in Omni keeps its clients somewhere else. We do too:
ADR 0032 exists only to copy Omni mail into Attio. The CRM is the third module (ADR 0035):
companies, people and deals, small, sitting on the mail and the files the workspace already has.
Product detail, the API and the plan are in `docs/spec/crm.md`.

The founder decided four things on Nov 16, 2026, and they shape the rest:

1. **A won deal is the project.** One record goes from lead to delivered. No Projects object.
2. **Add once, then automatic.** Nobody enters the CRM by themselves. One action adds a person;
   from then on their mail shows on the record without filing.
3. **Only mail you can open.** A record's timeline shows a member the emails they can already
   read, and nothing about any other mailbox.
4. **Contracts are stored natively now and signed natively later** (ADR 0037).

## Decision

### 1. Who has a CRM, and who sees it

- Every **company workspace** has one CRM. A Personal space (ADR 0024) has none: records are
  shared by nature and their files live in Shared, which a Personal space lacks.
- **Every member of the company reads and writes every record.** This is the Shared drive's
  rule (ADR 0034), so a record and its files always have the same audience. Private records and
  roles per record are not in v1.
- Deleting for good and editing stages are for owners and admins. Everything else is for every
  member.
- It is in the flat plan with no meter (ADR 0015, ADR 0035 decision 3). A read-only workspace
  keeps reading its CRM; writes answer `402 BILLING_INACTIVE` through the existing gate.

### 2. Data model

One schema file, `packages/db/src/schema/crm.ts`. Every table has `org_id`. Ids are UUIDv7.

| Table                 | Columns                                                                                                                                                                                  | Notes                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `crm_companies`       | id, org_id, name, description, folder_node_id, created_by_member_id, archived_at, timestamps                                                                                             |                                                                                                        |
| `crm_company_domains` | org_id, company_id, domain                                                                                                                                                               | Unique on (org_id, domain). Webmail domains are refused.                                               |
| `crm_people`          | id, org_id, name, company_id, job_title, phone, created_by_member_id, archived_at, timestamps                                                                                            | One company per person.                                                                                |
| `crm_person_emails`   | org_id, person_id, address, is_primary                                                                                                                                                   | Unique on (org_id, address): an address is one person. This is the key mail joins on.                  |
| `crm_stages`          | id, org_id, name, kind (`open` \| `won` \| `done` \| `lost`), position                                                                                                                   | One pipeline. Seeded on first use: Lead, In progress (open), Won (won), Delivered (done), Lost (lost). |
| `crm_deals`           | id, org_id, name, company_id, stage_id, stage_entered_at, owner_member_id, value_minor, value_currency, won_at, closed_at, folder_node_id, created_by_member_id, archived_at, timestamps | `value_minor` is a bigint in the currency's minor unit.                                                |
| `crm_deal_people`     | org_id, deal_id, person_id                                                                                                                                                               | Who on the client's side is part of it.                                                                |
| `crm_notes`           | id, org_id, company_id \| person_id \| deal_id, body, author_member_id, timestamps                                                                                                       | Exactly one target, by a check constraint.                                                             |
| `crm_contracts`       | id, org_id, company_id, deal_id, title, status (`draft` \| `sent` \| `signed` \| `ended`), document_node_id, signed_at, effective_on, expires_on, created_by_member_id, timestamps       | At least one of company and deal (decision 6).                                                         |
| `crm_events`          | id, org_id, company_id, person_id, deal_id, kind, actor_member_id, data, dedupe_key, created_at                                                                                          | Append-only, written in the transaction of the change it records (as `conversation_events`, ADR 0021). |
| `crm_settings`        | org_id, default_currency, root_folder_node_id                                                                                                                                            | One row per workspace, made on first use.                                                              |

- **The stage kind carries the meaning; the name is the workspace's.** `open` is being sold,
  `won` is a running project, `done` is delivered, `lost` is lost. Several stages may share a
  kind, and a workspace renames, adds and reorders them. Code and, later, the client dashboard
  read the kind, never the name.
- Moving a deal sets `stage_entered_at`; entering a `won` stage for the first time sets
  `won_at`; entering `done` or `lost` sets `closed_at`. The rules are one transition function
  in `packages/db/src/crm/`, an explicit state type as `conversation-status.ts` is for the
  helpdesk, so the route, a bulk move and an agent cannot disagree, and a repeated move changes
  nothing and writes no event.
- No currency is in code. A deal with a value names its currency; `default_currency` is the
  last one the workspace used.
- A member's rows survive them. `owner_member_id`, `created_by_member_id`, `author_member_id`
  and `actor_member_id` are `on delete set null`, so removing a member is never blocked and
  needs no hand-over.
- Archive hides a record everywhere and keeps it. Delete for good cascades to its notes,
  events and links, and leaves its files in Storage.

### 3. One access path, two doors

Routes never query `crm_*` tables. Access is decided in `packages/db/src/crm.ts`:

1. **Member**: `db.forMember(memberId).crm`. Every record of the member's company. Nothing in a
   Personal space, and nothing in another workspace.
2. **Guest**: `db.forUser(userId, scope).crm`. Empty in v1. ADR 0037 opens it for clients, by
   address, the way Storage's grant door works.

There is no public door.

### 4. Mail: add once, then automatic

- **Adding.** `POST /api/crm/people` with a name and an address makes the person. Unless the
  domain is webmail, it also finds the company with that domain or makes it, named by
  `companyFromAddress` (ADR 0035 decision 5). Adding an address that already has a person
  returns that person: the unique key decides it, so two members adding the same sender at once
  make one row.
- **Then automatic, by address.** Nothing is filed. A record's timeline asks Mail for the
  threads that involve its addresses: a person's own, a deal's people's, and for a company its
  people's plus anyone at its domains.
- **Mail answers through its own door.** Mail gains one read, `threadsWith(addresses, domains)`,
  on `forMember` and `forUser`. It joins `mailbox_access` like every mail read, so a member
  sees a thread on a record exactly when they could open it in the inbox. A teammate's personal
  mailbox contributes nothing, not even a count. A session scoped to a company (ADR 0024) sees
  that company's mail only.
- **Mail gains an index for it.** `messages.to` and `cc` are JSON, which cannot serve this
  lookup. A new mail-owned table, `thread_participants` (org_id, mailbox_id, thread_id,
  address, domain), is written where message rows are written, so live mail, import and
  re-sync all fill it, and a backfill covers what is already there. It is derived from the mail
  host like the rest of the mail index (ADR 0013). The exact indexes are chosen from
  `pnpm perf:explain` numbers on the 200k-message database before the layer merges.
- **The other direction.** `GET /api/crm/lookup` takes a thread's addresses and returns the
  people, companies and open deals that match, for the conversation sidebar. Every member sees
  every record, so this leaks nothing.
- **Helpdesk customers stay what they are** (ADR 0021): per inbox, filled on ingest, visible
  only through conversations. A customer and a person with the same address are shown together
  at read time. A customer is never promoted to a person automatically, which would show the
  whole workspace who wrote to an inbox they are not on.
- No interaction facts are stored ("last contacted"). They would have to be per viewer or
  break decision 3. They arrive with opt-in sharing (see "Not in v1").

### 5. Files: a record's files are a folder in Shared

- A company and a deal each get a folder the first time a file is added:
  `Shared / Clients / <company> / <deal>`. The record stores the folder's node id
  (`folder_node_id`), so renaming or moving the folder in Storage changes nothing.
- Creation is find-or-create under a row lock on the record: two uploads at once make one
  folder. If the folder was deleted, the next file makes a new one.
- **The apps use Storage's own API on that folder** (ADR 0034 decision 6) for listing,
  uploading, downloading and sharing. CRM adds no file routes and no bytes of its own: one
  file system, one quota, one meter, one sharing model.
- CRM calls Storage only through its member door (ADR 0035 decision 4).

### 6. Contracts are stored natively

A contract is a row on a deal or a company with a title, a status, three dates and one file in
that record's folder.

| Status   | Means                                    | Set by                                 |
| -------- | ---------------------------------------- | -------------------------------------- |
| `draft`  | Being written. The file can be replaced. | Creating it                            |
| `sent`   | With the client.                         | A member, by hand in v1                |
| `signed` | Executed. `signed_at` is set.            | A member attaching the executed copy   |
| `ended`  | Expired or terminated.                   | A member; later, a job on `expires_on` |

- **A signed contract's file cannot be lost.** Storage gains one thing, a lock:
  `storage_nodes.locked_at` and `locked_by_member_id`. A locked file cannot be renamed, moved,
  replaced, trashed or deleted for good, and a folder holding one cannot be trashed. Marking a
  contract signed locks its file in the same transaction. Only an owner or admin unlocks.
  Deleting the workspace still deletes everything.
- The lock is Storage's, reached through Storage's surface, so Storage does not learn what a
  contract is. It is useful without CRM and it is what signing needs (ADR 0037).
- `document_node_id` is `on delete set null`: purging a draft's trashed file leaves the
  contract without a document and never fails Storage's purge.
- v1 stores and tracks. Signing inside Omni is ADR 0037.

### 7. API, realtime, agents

- `/api/crm` on the Worker, in `apps/worker/src/crm/`, typed by `@omni/contracts/crm.ts`. The
  route list is in `docs/spec/crm.md`.
- Every write publishes `crm.changed` with the kind and ids on the workspace's realtime object.
- The MCP server gains `crm_search`, `crm_fetch` and `crm_write`, behind new scopes `crm:read`
  and `crm:write` (ADR 0029). They call the member door. No model is called by the CRM itself
  in v1, so it spends none of the triage allowance.

## Why this small

The patterns worth taking from Attio and Twenty are the ones that remove work: records that
fill from mail, one timeline per record, a pipeline you drag, files and contracts on the
record, an API an agent can drive. Each is in v1 in its smallest form. The patterns that cost
setup before they pay back are left for later, and each can be added without changing what v1
stores.

## Not in v1

- **Custom fields, lists and saved views.** The flexible model is what Attio and Twenty are
  known for and it is the first follow-up: typed definitions per workspace and values in a
  JSON column on each record. v1 has fixed columns so the first screens ship.
- **Tasks and reminders**, record merging, CSV and Attio import, several pipelines, tags.
- **Opt-in mail sharing.** A mailbox owner choosing to show the workspace who they wrote to and
  when (or subjects too), which is what makes stored "last contacted" possible. Planned as the
  layer right after v1.
- **AI on records** (a relationship summary, a suggested next step, a suggestion to add a
  sender). Each would count against an allowance and gets its own decision.
- The client dashboard, deliverables and signing (ADR 0037). The iOS app.
- Linking one thread to one deal by hand. A deal shows the mail of its people.

## Consequences

- **CRM rows are the truth, not an index.** Nothing rebuilds a deal or a note. Like Storage's
  rows (ADR 0034), they depend on database backups.
- Storage changes for the first time because of another module: one additive column pair and a
  check in its tree and trash operations. It is called out here because Storage has another
  owner.
- Mail changes too: one additive table written on the ingest path, and one read. A wrong or
  missing `thread_participants` row hides a thread from a timeline, never from the inbox, and a
  re-sync repairs it.
- Everyone in a company sees every client, deal value and contract. That is right for the
  small teams Omni is for, and it is the first thing a larger customer will ask to change.
- The CRM forwarding address (ADR 0032) stays. It is for teams whose CRM is elsewhere.
- New config: none. Packages touched: `@omni/db`, `@omni/contracts`, `@omni/mail-core`,
  `@omni/worker`, `apps/web`. `apps/mail` and `@omni/crypto` are not.

## Rollout and verification

Layers, each additive and one PR in a stack, are in `docs/spec/crm.md` "Plan", with the e2e
that proves each and the bug it is named for.

## Amendments

- **2026-11-16: new tables land first, in their own layer.** Migrations, the Worker and the mail
  service deploy independently (AGENTS.md "Database": expand, then contract). A column added to
  an existing table breaks the code still running on the old schema, since Drizzle's `select()`
  names every declared column, and a writer that inserts into a table not yet migrated breaks
  ingestion. So every table this ADR adds (`storage_locks`, `thread_participants`,
  `thread_participants_backfill`, the `crm_*` tables) ships in one schema-only layer, before any
  code that reads or writes it.
  - Decision 6: the lock is a row in `storage_locks` (`node_id`, `org_id`, `locked_at`,
    `locked_by_member_id`), not columns on `storage_nodes`. A file is locked while its row
    exists; deleting the node or the workspace takes the row with it.
  - Decision 4: the backfill keeps a cursor per mailbox in `thread_participants_backfill` and
    reads messages in id (UUIDv7, time) order from it every minute, so mail an older mail
    service stores during a deploy is indexed too. `messages` gains no column.

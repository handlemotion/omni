# Omni CRM: the client layer

Nov 16, 2026 · Draft for review · Extends `docs/spec/v1.md` and `docs/spec/modules.md`

## Summary

Every company workspace gets a CRM: the companies it works with, the people there, and the
deals with them. It is small on purpose. What makes it worth using is where it sits: on the
mail and the files the workspace already has in Omni.

- Add someone from an email once, and every email with them is on their record from then on.
  Nobody files anything.
- A deal's files are a folder in the shared drive. Its contract is a file there that cannot be
  lost once it is signed.
- A won deal is the project. The same record goes from lead to delivered, and later it is what
  the client sees when they sign in.

## Goals and non-goals

**Goals**

- Companies, people and deals, with one pipeline you can rename.
- A timeline on every record: what changed, notes, contracts, and the emails you can open.
- Adding a person takes one action from any email.
- Contracts stored on the deal or the company, with a status and dates.
- Everything an app can do, an agent can do through MCP.
- No new service, no new config, nothing to turn on.

**Non-goals for v1** (each is additive later)

- Custom fields, lists, saved views, tags, several pipelines.
- Reminders, record merging, imports.
- Stored "last contacted" facts, and sharing a personal mailbox's activity with the workspace.
- AI on records.
- The client dashboard, deliverables and signing.
- A CRM in a Personal space. The iOS app.

## What we take from Attio and Twenty

| Pattern                             | In v1                                                         | Later                                    |
| ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| Records fill from mail              | Add once, then every email shows by itself                    | Opt-in sharing across the workspace      |
| Company from the email domain       | Made or found when a person is added; webmail makes none      | Enrichment (logo, description)           |
| One timeline per record             | Events, notes, contracts, emails, merged newest first         | Meetings, files, tasks                   |
| A pipeline you drag                 | Stages with a fixed kind and a free name; a board by stage    | Several pipelines, saved views           |
| Notes on records                    | Plain notes on one record                                     | Mentions, notes on several records       |
| Files on records                    | The record's folder in Shared, plus Drive files linked in place | Previews                                 |
| An API first, and agents            | Every route typed; MCP tools                                  | Webhooks                                 |
| A flexible data model               | Fixed columns                                                 | Custom fields as definitions plus JSON   |
| Contracts and a client's own view   | Stored, tracked, sent and signed in Omni                      | The client dashboard |

## Objects

- **Company.** A name and its domains. A domain belongs to one company.
- **Person.** A name, their addresses, one company, a job title, a phone. An address belongs
  to one person.
- **Deal.** A name, a company, the people involved, an owner, a value in a currency, a stage.
- **Stage.** A name the workspace picks and a kind it does not: `open` (being sold), `won` (a
  running project), `done` (delivered), `lost`. New workspaces start with Lead, In progress,
  Won, Delivered, Lost.
- **Note.** Text on one company, person or deal.
- **Contract.** A title, a status (`draft`, `sent`, `signed`, `ended`), three dates and a
  file, on a deal or a company.
- **Task.** A title, notes, an assignee, a due time, done or open, on one company, person or
  deal, or on none.
- **Milestone.** A checkpoint on a deal: a title, a description, a target day, a status
  (`planned`, `in_progress`, `done`) and a place in the deal's order.
- **Deliverable.** Something a deal hands over: a title, a description, maybe a milestone of the
  same deal, maybe a Drive file, a due day, a status (`draft`, `in_review`, `approved`,
  `changes_requested`) and whether the client sees it.

Every member of the company sees and edits all of it.

## How people use it

**Add someone from mail.** On any conversation, one action adds the sender. Omni makes the
person, and their company from the domain unless it is gmail.com or the like. If the address
is already a person, nothing is duplicated. The conversation now shows who they are, their
company and their open deals, to every teammate who opens it.

**Open a record.** A person's page shows their details and a timeline. The emails in it are
the ones this member can open: their own mailboxes and the shared inboxes they are on. Two
teammates looking at the same client can see different emails, and neither learns about mail in
a mailbox that is not theirs.

**Work the pipeline.** Deals sit on a board by stage. Dragging a deal to a `won` stage records
when it was won. That is the only ceremony: the deal carries on as the project.

**Keep the files.** A deal's Files are a folder in Shared, under `Clients`. Dropping a file on
the deal uploads it there, and the same folder is in Storage, where it can be shared like any
other. A file that already lives elsewhere in Drive is linked, not moved or copied (founder's
call, Nov 20, 2026): "Add from Drive" adds a reference, like a symlink, in `crm_file_links`, and
the record shows it beside its folder's files. Removing it from the record drops only the link.
Each member sees the links whose file they can open in Drive (not in Trash, not a teammate's My
files); deleting the file for good, or the record, removes the link. The first link makes the
record's folder, as the first upload does.

**Store the contract.** A contract starts as a draft with its file. When the client signs on
their own side (their supplier portal, another e-signature service, paper), a member may mark it
sent, then uploads the executed PDF as its signed copy (`POST /contracts/:id/signed-copy`): it
lands in the record's folder, and the member enters the day it was signed and who signed (names,
addresses optional; the deal's people are suggested). The contract becomes `signed` with that
copy as `signedNodeId` and the signers as `signedBy`, the draft stays as its document, and both
files are locked: they cannot be renamed, moved or deleted by anyone but an owner or admin
unlocking them first. A contract marked signed without its copy takes one later and keeps its
date. A contract out for signature from Omni refuses one (void it first), and so does one that
already has its signed copy. From there it is tracked like any signed contract, through expiry.

**Sign the contract in Omni.** A draft whose file is a PDF is sent for signature from the deal:
the member names the signers (the deal's people are suggested), and the contract goes out
through Storage's signing. Each signer gets their own link to `/sign/:id`, which opens that
one request as them for 30 days with no account (a signed-in person with that address opens it
too). They read the PDF, accept the consent and sign with a code mailed to them, so a forwarded
link alone cannot sign. The
contract shows each signer as waiting, viewed or signed. When the last one signs, Storage seals a
copy with its signature certificate beside the document, which is in the deal's folder, and the
CRM's minute job records the contract `signed` with that copy (`signedNodeId`). Voiding takes it
back to `draft`. A signed contract with an end date shows when it ends within 30 days, and the
daily job ends it after that date.

**Plan a project.** A deal's plan is its milestones and deliverables, the way Linear plans a
project: milestones in an order the team drags, each with a target day, and the deliverables
under them. A deliverable's file is a Drive file the member can open, usually in the deal's
folder. Deleting a milestone keeps its deliverables on the deal, under none. A deal holds at most
200 of each, so the plan is always read whole. Days are days (`YYYY-MM-DD`), the same on every
client.

## API

All under `/api/crm` on the Worker, for the active workspace. Shapes live in
`@omni/contracts/crm.ts`. Lists are cursor paged. A Personal space answers `404 NO_CRM`.

| Route                                                               | Does                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /companies` · `POST /companies`                                | List by name, `?q=` to filter. Create.                                                                       |
| `GET /companies/:id` · `PATCH` · `DELETE`                           | Read with domains, people and deals. Change. Archive; `?forever=1` deletes for good (owners and admins).     |
| `PUT /companies/:id/domains/:domain` · `DELETE` the same            | Add or remove a domain. A webmail or taken domain is refused.                                                |
| `GET /people` · `POST /people`                                      | List, `?q=`, `?company=`. `POST` is "add once": an address that has a person returns that person.            |
| `GET /people/:id` · `PATCH` · `DELETE`                              | Read. Change, addresses included. Archive or delete.                                                         |
| `GET /deals` · `POST /deals`                                        | List, `?stage=`, `?kind=`, `?owner=`, `?company=`. Create.                                                   |
| `GET /deals/:id` · `PATCH` · `DELETE`                               | Read with its people and contracts. Change, move stage, set people. Archive or delete.                       |
| `GET /stages` · `PUT /stages`                                       | The ordered list. Replace it (owners and admins): rename, add, reorder. A stage holding deals stays.         |
| `POST /notes` · `PATCH /notes/:id` · `DELETE /notes/:id`            | Write a note on one record. Its author edits or deletes it.                                                  |
| `GET /companies/:id/timeline` · same for people and deals           | The merged timeline, newest first.                                                                           |
| `POST /companies/:id/folder` · `POST /deals/:id/folder`             | Finds or makes the record's folder and returns its node id. The apps then use `/api/storage` on it.          |
| `GET /companies/:id/links` · `POST` · `DELETE …/links/:nodeId` (and deals) | Drive files linked where they live. `POST` takes `nodeIds` the member can open now; linking twice is a no-op. |
| `GET /contracts` · `POST /contracts` · `PATCH /contracts/:id` · `DELETE` | List by `?company=` or `?deal=`. Create. Change status, dates or file. Delete (never a signed one).     |
| `POST /contracts/:id/send` · `POST /contracts/:id/void`             | Send a draft's PDF to its signers; void the open request (back to draft). `SIGNATURE_OPEN` while it is out.  |
| `POST /contracts/:id/signed-copy`                                   | Signed elsewhere: the executed PDF, when, and who signed. The contract is `signed` with it; both files lock.  |
| `POST /companies/:id/restore` · same for people and deals          | Brings an archived record back.                                                                   |
| `POST /companies/bulk` · same for people and deals                 | One action (`archive`, `restore`, `delete`, `owner`; deals `stage`) on up to 200 ids, each by its own rules. |
| `GET /lookup?address=`                                              | Up to 50 addresses. The people, companies and open deals that match, for the conversation sidebar.           |
| `GET /search?q=`                                                    | People, companies and deals whose name, address or domain starts with the words. For pickers.                |
| `GET /settings` · `PUT /settings`                                   | The default currency.                                                                                        |
| `GET /tasks` · `POST /tasks` · `GET /tasks/counts`                  | List by `?status=`, `?assignee=`, `?due=`, `?company=`/`?person=`/`?deal=`, `?q=` (see Tasks). Create. Counts.    |
| `GET /tasks/:id` · `PATCH` · `DELETE`                               | Read. Change, complete or reopen (`done`), move to another record. Delete.                                   |
| `GET /deals/:id/plan`                                               | The deal's milestones in order and its deliverables, oldest first.                                           |
| `POST /deals/:id/milestones` · `PATCH /milestones/:id` · `DELETE`   | Add one last. Change; `position` moves it. Delete; its deliverables stay, under no milestone.                 |
| `POST /deals/:id/deliverables` · `PATCH /deliverables/:id` · `DELETE` | Add, change, delete. `milestoneId` is one of the deal's, `nodeId` a file the member can open.              |

- Every list takes `sort` (`name`, `created`, `updated`; deals also `value`, `closeOn`,
  `stageEntered`), `dir`, `owner` (an id or `none`), `createdAfter`, `createdBefore` and
  `archived` (`1` with archived, `only` archived alone). Companies take `domain`; people
  `hasCompany`; deals `closeAfter`, `closeBefore`, `minValue`, `maxValue`.
- Error codes beside `error`: `NOT_FOUND`, `NO_CRM`, `ADDRESS_TAKEN`, `DOMAIN_TAKEN`,
  `WEBMAIL_DOMAIN`, `STAGE_IN_USE`, `STAGE_KIND_REQUIRED` (each kind keeps at least one stage),
  `INVALID_CURRENCY`, `CONTRACT_SIGNED`, and the platform's `BILLING_INACTIVE`.
- A contract goes `draft` → `sent` → `signed` → `ended`; `draft` may go straight to `signed`
  and `sent` back to `draft`. Its file is replaced while `draft`, or with the move that takes a
  `sent` one back to draft or to `signed`. Once signed it never goes back, keeps its file and
  its row, and its company or deal is not deleted for good (`CONTRACT_SIGNED`).
- `PATCH` changes only the fields it names. Two members editing different fields both win; on
  the same field the later write wins. There is no version check in v1.
- Every write publishes `{ type: "crm.changed", kind, ids }` to the workspace's sockets.

### The timeline

One list, newest first, of four kinds of item:

| Item       | From                                     | Shows                                                    |
| ---------- | ---------------------------------------- | -------------------------------------------------------- |
| `event`    | `crm_events`                             | Created, stage moved, owner or value changed, people set |
| `note`     | `crm_notes`                              | The text and its author                                  |
| `contract` | `crm_events` of a contract               | Created, sent, signed, ended                             |
| `thread`   | Mail, through `forUser(...).threadsWith` | Subject, snippet, mailbox, last message time, its `url`  |

- The addresses asked of Mail are a person's own; for a deal, its people's; for a company, its
  people's plus its domains.
- Threads come from every mailbox the person can open inside their session's scope, their
  Personal space included. It is their own mail, shown only to them.
- Each source is asked for one page older than the cursor; the pages are merged and cut to the
  limit. The cursor is the last item's time and id.

### Tasks

- `crm_tasks` holds them: on at most one record (a check constraint), cascading with it.
  Assigned to the creator unless the request says otherwise (`assigneeMemberId: null` is
  nobody); a removed member leaves their tasks unassigned.
- `due_at` is a moment. A client picking a day sends the end of that day in its own time zone,
  so "overdue" (`due_at < now()`) is the same answer on every client.
- Done is `completed_at`, with who did it. `PATCH { done }` sets or clears it; completing a done
  task changes nothing.
- `GET /tasks` lists open tasks soonest due first, undated last, and `?status=done` most recently
  completed first, each with a partial index and a keyset cursor. `?assignee=` takes a member
  id, `me` or `none`; `?due=` is `overdue`, `upcoming` or `none`. Each task carries its record's
  name.
- A record's tasks are its own: a company's panel does not gather its deals' tasks.
- Writes publish `crm.changed` with kind `task`, plus the record's kind. Tasks write no timeline
  events yet. Not yet: reminders, recurring tasks, subtasks, several records per task, MCP tools.

## Records parity

Nov 20, 2026. Companies, people and deals at the level of Attio, HubSpot, Folk and Pipedrive for
the everyday flows: create, edit, find, archive and delete; lists with sort, filter and search; a
board by stage; a won deal is the project.

- **Owners and a close date.** Companies and people have an owner like deals do
  (`owner_member_id`, `on delete set null`). Deals have `expected_close_on`. A company made by
  hand is its creator's; one made from an address, and every person, starts with none.
- **Sort.** Every list sorts by name, created or updated, and deals also by value, close date
  and stage entered, either way. The cursor carries the sort, the last row's value and its id, so
  pages hold still; unvalued and undated deals come last both ways. A cursor from before this
  (by name) still pages. `lastContactedAt` does not sort: it is computed per viewer at read time.
- **Filter.** Owner (a member or nobody) and creation time on every list; companies by domain;
  people by company or having none; deals by stage, kind, company, close date and value ranges.
  Filters combine. Saved views stay out.
- **Restore.** An archived record comes back with `POST /:records/:id/restore`, which writes a
  `restored` event.
- **Bulk.** One action (`archive`, `restore`, `delete`, `owner`, and `stage` for deals) on up to
  200 ids. Each id goes through the single route's door function in its own transaction, so every
  rule holds (only owners and admins delete, a signed contract outlives its record, stage moves
  set `won_at` once), and the answer says by id what changed and what was refused.
- **A person's deals** come with `GET /people/:id`.
- **Currency.** The apps always send a currency with a value: the deal's own, else the
  workspace default, else the device's. The API still refuses a value with no currency at all.
- **Projects** are deals in a `won` stage (`kind=won`); the apps list them on their own.
- **Navigation.** The sidebar (the iOS menu) lists the CRM's pages (Companies, People, Deals, …),
  then **Active projects**: each deal in a `won` stage, by name, with its client's logo at the
  end. There are no stage shortcuts: the board and filters do that.

Still out: custom fields, saved views, several pipelines, merging duplicates, imports.

## Agents

Four tools on the MCP server, through the same member door:

| Tool         | Scope       | Does                                                                                     |
| ------------ | ----------- | ---------------------------------------------------------------------------------------- |
| `crm_search` | `crm:read`  | Finds people, companies and deals by words, kind, owner, archived, stage kind or close date. Compact rows. |
| `crm_fetch`  | `crm:read`  | Reads up to 10 records with their people, deals, contracts, files, open tasks, a deal's plan, recent notes and thread ids. |
| `crm_tasks`  | `crm:read`  | Lists tasks by status, assignee, due (overdue, upcoming, none), record or title words.    |
| `crm_write`  | `crm:write` | Adds or changes a record, task, milestone, deliverable or draft contract, archives or restores, links files, adds a note, or changes many at once. Never deletes or sends. |

Thread ids from `crm_fetch` go to the mail `fetch` tool, which applies mail's own access. Note
text is written by teammates, and names and titles can come from mail: the server's
instructions keep telling agents to treat it as data.

- A token reaches the company workspaces its grant does: its one workspace, or every company
  the person belongs to (`workspace` narrows a read; a write to one of several must name it). A
  Personal space has no CRM, so a token that reaches only one gets a tool error.
- Every row carries `kind`, `id`, `workspace` and a `url` on the web app
  (`/<workspace slug>/crm/people/<id>`, `…/companies/<id>`, `…/deals/<id>`), which agents cite.
- Tasks: `crm_tasks` lists them (open by default, soonest due first) with their record,
  assignee, due time and a `url` (`/<slug>/crm/tasks/<id>`); `crm_fetch` gives each record its
  open tasks; `crm_write`'s `task` adds one (assigned to the caller unless `assignee` says
  otherwise), changes it, moves it to another record, or completes it with `done: true`.
- Files and contracts: a company's or deal's `crm_fetch` carries its Drive `folder_id`, its
  linked `files` (ids for `drive_fetch`, and a `url` to the file in its folder) and its
  `contracts` with each one's signing progress (signers, viewed and signed times).
  `crm_write`'s `files` links Drive nodes the person can open, or unlinks them; nothing moves.
  `crm_write`'s `contract` adds a draft on a company or deal or changes its title, document
  (a file in Shared) and dates. Sending for signature, voiding, and marking a contract sent or
  signed reach people outside Omni or bind the company, so they stay with a person in the app.
- Plans: a deal's `crm_fetch` carries its `plan` (milestones in order, deliverables with their
  `file_id`, status and `client_visible`). `crm_write`'s `milestone` and `deliverable` add one
  (`deal` and `title`) or change one by `id`; nothing is deleted.
- A company change (fields, `add_domains`, `remove_domains`, `archived`) runs in one
  transaction through `memberCrm().changeCompany`: a refused domain rolls back the rest.
- `crm_fetch` takes `records: [{ kind, id }]`. Its thread ids come from
  `forUser(user, grant scope).threadsWith`, so they are threads the person can open.
- Every row carries its `owner` (name and address, or null); a deal's also carries
  `expected_close_on`. `crm_search` filters by `owner` (`"me"`, a teammate's email or `"none"`),
  `archived` (`exclude` by default, `include`, `only`) and, for deals, `close_after` /
  `close_before`. A won deal is a running project (`stage_kind: won`).
- `crm_write` takes exactly one of `person`, `company`, `deal`, `note` or `bulk`; with `id` it
  changes that record, without it adds one. A deal's `stage` (name or id) moves it; `owner` sets
  who owns any record; `archived: true` archives and `false` restores. A company's domains change
  with `add_domains` / `remove_domains`. `bulk` is one change (archive, restore, owner, or a deal's
  stage) to up to 200 records of one kind, through the same door as the app's bulk bar: each
  record in its own transaction, refusals listed by id. Deleting for good stays in the app. Each
  write passes the read-only billing gate, announces `crm.changed` and writes one `mcp.crm_write`
  audit row per record it changed.

## Plan

One stack for the CRM (C1 to C5), with two small PRs on `main` first for the modules it leans
on (M1, S1). The order and what depends on what are in `docs/spec/modules.md` "Plan". Each
layer is done when its e2e passes against the local stack and it has been run by hand with real
HTTP calls, as AGENTS.md "Verify it running" asks.

Each test below is named for the bug it catches.

**M1. Mail: `thread_participants` and `threadsWith`** (`@omni/db`, `apps/mail` e2e)

- A thread in a shared inbox is returned to a member on that inbox and not to one who is not.
- A thread in a teammate's personal mailbox is returned to nobody else, admins included.
- An address that was only ever in Cc is found; `Ana@Acme.com` and `ana@acme.com` are one.
- A mailbox wiped and synced again from GreenMail ends with the same participants.
- A session scoped to a company gets no Personal-space threads.
- `pnpm perf:explain` numbers for `threadsWith` on the 200k-message database, before and after.

**S1. Storage: the lock** (`@omni/db`, `apps/worker` e2e)

- A locked file answers `409 LOCKED` to rename, move, trash and delete for good, for members
  and for editors by grant.
- Trashing a folder that holds a locked file two levels down is refused.
- A member cannot unlock; an admin can, and the file is then an ordinary file.
- Deleting the workspace still removes locked files and their objects.

**C1. CRM in `@omni/db`**

- A member of another company gets nothing through the member door, by id or by list.
- A Personal space has no CRM.
- Two adds of one address at the same moment make one person.
- `ana@acme.com` makes Acme with `acme.com`; `bea@acme.com` joins it; `x@gmail.com` makes no
  company.
- Moving a deal to Won twice sets `won_at` once and writes one event.
- Removing a member is not blocked by their deals and notes, which stay with no owner.

**C2. CRM in the Worker**

- Two members open one person's timeline: each sees the thread from the inbox they are on, and
  neither sees the other's.
- A read-only workspace reads every route and gets `402` on every write (the existing
  billing-gate test walks every write route in `app`).
- `crm.changed` reaches a teammate's socket and no socket of another workspace.
- `lookup` returns a person for an address in any letter case, and nothing from another
  workspace.

**C3. Record folders and contracts**

- Two first uploads to one deal at the same moment make one folder.
- Marking a contract signed locks its file in the same request; a failure leaves neither done.
- Purging a draft's trashed file leaves the contract without a document and the purge succeeds.
- A signed contract cannot be deleted.

**C4. Agents**

- A token without `crm:read` cannot call the tools; one granted a single workspace sees only
  that workspace's records.

**C5. Web**

- The screens, run against the local stack with `pnpm stack:serve`. Which screens and from
  what designs is an open question below.

## Open questions

- [x] Web screens: built now from Mobbin references; the founder redesigns them later.
- [ ] The starting stage names (Lead, In progress, Won, Delivered, Lost) and the folder name
      (`Clients`). Both can be renamed by a workspace; these are only what a new one sees.
- [x] Bringing our own records over from Attio: by hand. No imports in v1.

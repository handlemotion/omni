# Omni CRM: the client layer

Nov 16, 2026 · Draft for review · Extends `docs/spec/v1.md` and `docs/spec/modules.md` ·
Decisions: ADR 0036 (v1), ADR 0039 (v1 close-out), ADR 0037 (later)

## Summary

Every company workspace gets a CRM: the companies it works with, the people there, and the
deals with them. It is small on purpose. What makes it worth using is where it sits: on the
mail and the files the workspace already has in Omni.

- Add someone from an email once, and every email with them is on their record from then on.
  Nobody files anything.
- A deal's files are a folder in the shared drive. Its contract is a file there that cannot be
  lost once it is signed.
- A won deal is the project. The same record goes from lead to delivered, and later it is what
  the client sees when they sign in (ADR 0037).

## Goals and non-goals

**Goals**

- Companies, people and deals, with one pipeline you can rename.
- A timeline on every record: what changed, notes, contracts, and the emails you can open.
- Adding a person takes one action from any email.
- Contracts stored on the deal or the company, with a status and dates.
- Everything an app can do, an agent can do through MCP.
- No new service, no new config, nothing to turn on.

**Non-goals for v1** (each is additive later; ADR 0036 "Not in v1")

- Custom fields, lists, saved views, tags, several pipelines.
- Tasks, reminders, record merging, imports.
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
| Files on records                    | The record's folder in Shared                                 | Previews                                 |
| An API first, and agents            | Every route typed; MCP tools                                  | Webhooks                                 |
| A flexible data model               | Fixed columns                                                 | Custom fields as definitions plus JSON   |
| Contracts and a client's own view   | Stored and tracked                                            | Signed in Omni; the dashboard (ADR 0037) |

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

Every member of the company sees and edits all of it (ADR 0036 decision 1).

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
other.

**Store the contract.** A contract starts as a draft with its file. A member marks it sent,
then attaches the executed copy and marks it signed. From then the file is locked: it cannot be
renamed, moved or deleted by anyone but an owner or admin unlocking it first.

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
| `GET /contracts` · `POST /contracts` · `PATCH /contracts/:id` · `DELETE` | List by `?company=` or `?deal=`. Create. Change status, dates or file. Delete (never a signed one).     |
| `GET /lookup?address=`                                              | Up to 50 addresses. The people, companies and open deals that match, for the conversation sidebar.           |
| `GET /search?q=`                                                    | People, companies and deals whose name, address or domain starts with the words. For pickers.                |
| `GET /settings` · `PUT /settings`                                   | The default currency.                                                                                        |

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

| Item       | From                                    | Shows                                                    |
| ---------- | --------------------------------------- | -------------------------------------------------------- |
| `event`    | `crm_events`                            | Created, stage moved, owner or value changed, people set |
| `note`     | `crm_notes`                             | The text and its author                                  |
| `contract` | `crm_events` of a contract              | Created, sent, signed, ended                             |
| `thread`   | Mail, through `forUser(...).threadsWith` | Subject, snippet, mailbox, last message time, its `url`  |

- The addresses asked of Mail are a person's own; for a deal, its people's; for a company, its
  people's plus its domains.
- Threads come from every mailbox the person can open inside their session's scope, their
  Personal space included. It is their own mail, shown only to them.
- Each source is asked for one page older than the cursor; the pages are merged and cut to the
  limit. The cursor is the last item's time and id.

## Agents

Three tools on the MCP server (ADR 0029), through the same member door:

| Tool         | Scope       | Does                                                                                           |
| ------------ | ----------- | ---------------------------------------------------------------------------------------------- |
| `crm_search` | `crm:read`  | Finds people, companies and deals by words, kind, stage kind or owner. Compact rows.            |
| `crm_fetch`  | `crm:read`  | Reads up to 10 records with their people, deals, contracts, recent notes and thread ids.        |
| `crm_write`  | `crm:write` | Adds or changes a person, company or deal, moves a stage, adds a note. Never deletes.           |

Thread ids from `crm_fetch` go to the mail `fetch` tool, which applies mail's own access. Note
text is written by teammates, and names and titles can come from mail: the server's
instructions keep telling agents to treat it as data.

- A token reaches the company workspaces its grant does: its one workspace, or every company
  the person belongs to (`workspace` narrows a read; a write to one of several must name it). A
  Personal space has no CRM, so a token that reaches only one gets a tool error.
- Every row carries `kind`, `id` and `workspace`. A row gains a `url` (`/crm/people/<id>`,
  `/crm/companies/<id>`, `/crm/deals/<id>`) only once the web app serves those paths (C5), so an
  agent never cites a link that answers "Not found".
- `crm_fetch` takes `records: [{ kind, id }]`. Its thread ids come from
  `forUser(user, grant scope).threadsWith`, so they are threads the person can open.
- `crm_write` takes exactly one of `person`, `company`, `deal` or `note`; with `id` it changes
  that record, without it adds one. A deal's `stage` (name or id) moves it. It passes the
  read-only billing gate, announces `crm.changed` and writes an `mcp.crm_write` audit row.

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

- [x] Web screens: built now from Mobbin references; the founder redesigns them later (ADR 0039).
- [ ] The starting stage names (Lead, In progress, Won, Delivered, Lost) and the folder name
      (`Clients`). Both can be renamed by a workspace; these are only what a new one sees.
- [x] Bringing our own records over from Attio: by hand. No imports in v1 (ADR 0039).

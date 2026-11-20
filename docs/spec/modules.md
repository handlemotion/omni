# Omni modules: the tools a company runs on

Nov 16, 2026 · Draft for review · Extends `docs/spec/v1.md`

## Summary

Omni started as one inbox. It is becoming what Skiff was for a small company: mail, files and
clients in one workspace, with one sign-in and one bill. Each tool is a **module**. This spec
says how modules are built so they stay separate in code and feel like one product in use, what
connects them, and in what order the next pieces land.

The bet is the same as v1's, one level up. Hosting is a commodity we rent (Purelymail for mail,
R2 for bytes, Postgres for everything else). We spend our effort where the modules meet: a
client's emails on their record, a deal's contract in the shared drive, a file shared with the
same address a person signs in with.

## Where each module is

| Module           | What it is                                                | State (Nov 16, 2026)                                       |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Mail             | Inboxes, shared inboxes, helpdesk, AI triage, MCP         | In production                                              |
| Storage          | My files, Shared, sharing by address and by link          | 5 of 6 layers merged (#296 to #304); the web screens left  |
| CRM              | Companies, people, deals, contracts                       | Specified: `docs/spec/crm.md`                              |
| Client dashboard | Clients sign in, get deliverables, sign contracts         | Direction set, not scheduled                               |
| Calendar         | Events on the mail host over CalDAV                       | Not started; needs a spike first                           |

## Principles

- One platform, many modules. One Worker, one database, one sign-in, one bill.
- A module's tables are its own. Everything else reaches them through its doors.
- Modules link by reference and by address, never by copying each other's rows.
- A link never shows a person something they could not already open.
- Every module works on a self-hosted install with no new required service.
- Small first. A module ships its smallest useful form, shaped so the rest is additive.

## The shape of a module

Every module has this layout. For the CRM it looks like this:

```
packages/db/src/schema/crm.ts        tables, all named crm_*
packages/db/src/crm.ts               the surface: the doors, and nothing else is imported
packages/db/src/crm/                 private: what goes through the doors
packages/contracts/src/crm.ts        what the Worker answers the apps
apps/worker/src/crm/                 routes at /api/crm, jobs.ts, mcp.ts
packages/db/e2e/crm-*.e2e.test.ts    leak tests for each door
apps/worker/e2e/crm-*.e2e.test.ts
apps/web/src/components/crm/         screens (Rodrigo)
```

Storage has this shape in `@omni/db`, `@omni/contracts` and the Worker.
Mail predates it and moved into it in place: its tables keep their names.

## What is shared

Shared today, and used as is by every module:

- **People and workspaces**: users, members, Personal spaces, session scope (`@omni/auth`).
- **The doors**: `forMember` and `forUser`, one property per module.
- **The plan**: the read-only gate denies every write by default, so a new module's routes are
  covered without listing them.
- **Realtime, queue, crons, rate limits, system mail, request tracing** in the Worker.
- **The agent door**: `/mcp` and its OAuth scopes.
- **The typed client**: a new route shows up in `@omni/client` by itself.
- **API conventions**, already written in `contracts/src/storage.ts`: ISO 8601 dates, sizes in
  bytes, opaque cursors, errors as `{ error, code }`. Money is a minor-unit integer plus a
  currency code.

Becomes shared with this work:

- **Addresses and domains**: one normaliser in `@omni/mail-core`, moved out of
  `@omni/db/customers.ts`. Mail, Storage grants, the helpdesk and the CRM must agree on what
  "the same address" and "a company's domain" mean.
- **The module list**: `apps/worker/src/modules.ts`, where a module registers its minute and
  daily jobs and what it does when a member is removed or a workspace is deleted. Today
  `index.ts` and `@omni/auth` name Storage by hand.
- **The boundary check**: `scripts/check-modules.mjs`.

Stays separate on purpose: the two upload paths. Mail stages attachments for a send in the mail
bucket; Storage uploads in parts to its own. They meet in the "attach from Storage" link below,
not before.

## How modules enrich each other

The join key is the email address, and for companies the domain. Nothing below needs a sync
job, and each row is a reference, read through the far side's door.

| Link                    | What a person sees                                                                                  | How                                                                                           | When           |
| ----------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------- |
| Mail → CRM              | Add a sender to the CRM in one action. The conversation shows who they are, their company and deals. | `POST /api/crm/people`, `GET /api/crm/lookup`                                                 | CRM v1         |
| CRM → Mail              | A person, company or deal lists the emails with them that you can open.                             | Mail's door gains `threadsWith`                                                               | CRM v1         |
| CRM → Storage           | A record's files are a folder in Shared. A signed contract's file is locked.                        | `folder_node_id`; Storage's lock                                                              | CRM v1         |
| Helpdesk ↔ CRM          | A customer who is also a CRM person shows as one.                                                   | Address match at read time                                                                    | CRM v1         |
| Every module → agents   | Your agent searches and updates records beside your mail.                                           | MCP tools per module                                                                          | With each      |
| Mail → Storage          | Save an attachment to Storage.                                                                      | A Worker route calling both doors; the bytes are copied, since mail objects can be rebuilt     | After CRM v1   |
| Storage → Mail          | Attach a file from Storage; send a large file as a link.                                            | Compose accepts a Storage node as an attachment source; Storage's share link                   | After CRM v1   |
| Storage → CRM           | A file shared with a client's address shows on their record.                                        | Grantee address equals a person's address, at read time                                       | Later          |
| CRM → client            | The client signs in and sees their project, deliverables and contracts.                             | A deal guest, by address, through `forUser`                                                                | Later          |
| CRM → your phone        | The company's contacts in your own address book.                                                    | One-way CardDAV export by the mail service                                                    | Later          |
| Calendar → CRM          | Meetings with a person on their timeline.                                                           | Attendee addresses, at read time                                                              | With Calendar  |
| Every module → search   | One search box over mail, files and records.                                                        | Each module's surface offers a search; the Worker merges them                                 | Later          |

## DAV

Purelymail offers WebDAV, CardDAV and CalDAV at no extra cost, so it was the first thing to
check as a way to connect the modules. It is not that, and Purelymail's own documentation says
why:

- **WebDAV** caps a file at 50 MB and knows nothing of sharing, links or quotas. Storage stays
  on R2.
- **CardDAV** address books belong to one user and cannot be shared, so they cannot hold a
  company's CRM. They are a good place to _export_ the CRM's people for one member, later.
- **CalDAV** is the right base for a Calendar module, used the way mail uses IMAP: the host
  holds the events and Postgres is an index we can rebuild. Purelymail implements only the
  basic RFC, so Calendar starts with a spike.

Any DAV client lives in `apps/mail`, the only code that holds mailbox passwords.

## Plan

Each line is one PR. Nothing is destructive, and every layer works beside the previous version
of everything it touches.

**Now**

| #   | Layer                                                                                              | Module   | Depends on |
| --- | -------------------------------------------------------------------------------------------------- | -------- | ---------- |
| 0   | These documents                                                                                    |          |            |
| P1  | `scripts/check-modules.mjs` and its unit test; the AGENTS.md text, once approved                   | platform | 0          |
| P2  | The address and domain normaliser moves to `@omni/mail-core`                                       | platform | 0          |
| M1  | Mail: `thread_participants`, `threadsWith`, the backfill                                           | mail     | P2         |
| S1  | Storage: the file lock                                                                             | storage  | 0          |
| C1  | CRM in `@omni/db`: schema, migration, the member door, stage transitions, events                   | crm      | P2         |
| C2  | CRM in the Worker: records, stages, notes, search, lookup, timeline, `crm.changed`, `modules.ts`   | crm      | C1, M1     |
| C3  | CRM: record folders and contracts                                                                  | crm      | C2, S1     |
| C4  | CRM for agents: `crm_search`, `crm_fetch`, `crm_write`                                             | crm      | C2         |
| C5  | Web: the CRM screens                                                                               | crm      | C2, C3     |

- M1 and S1 change modules that have other owners. Each is its own PR on `main`, small and
  useful alone, and is coordinated with whoever holds that module's open stack. Storage's
  remaining layer (the web screens) is untouched by any of this.
- C1 to C5 are one stack. What each layer must prove is in `docs/spec/crm.md` "Plan".

**Next, in the order we would take them**

1. Opt-in mail sharing and the interaction facts it allows ("last contacted").
2. Custom fields, then saved views.
3. Mail ↔ Storage: save an attachment, attach from Storage.
4. Storage's Worker files move into the module layout; mail's follow when quiet.
5. The client dashboard and signing, once its open points are answered.
6. Tasks, imports (CSV, Attio), CardDAV export, the Calendar spike.

## Risks and open questions

| Risk                                                       | Why it matters                                           | Answer                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Modules in one Worker grow it past a size or startup limit | A deploy fails for every module at once.                 | Watch the bundle in CI. A module's surface can move behind a service binding.       |
| The boundary check is skipped "just this once"             | Access gets decided in two places.                       | It runs in `pnpm check`, and CI requires it. Debt is a list that only shrinks.                 |
| Two module stacks both add a migration                     | Drizzle's journal conflicts.                             | The later layer regenerates. Never hand-merged.                          |
| CRM and Storage rows are the truth                         | A lost row is lost work, unlike a lost mail index.       | Database backups are now a product requirement. Restore is tested before CRM holds real data.  |
| Everyone sees every record                                 | Fine at five people, wrong at fifty.                     | Named as the first change a larger customer asks for.                               |

**Open questions**

- [ ] CRM web screens: built now from references, as Storage's were, or
      after Figma frames exist. It does not block C1 to C4.
- [ ] Who owns M1 and S1: the CRM stack's author, or the mail and Storage owners.

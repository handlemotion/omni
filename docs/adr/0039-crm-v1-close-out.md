# 0039: CRM v1 close-out: screens, activity sharing, save to drive, contract expiry

Date: 2026-11-16 · Status: accepted · Amends: ADR 0036 decision 3 ("only mail you can open"),
decision 6 (the `ended` job) and "Not in v1"; `docs/spec/crm.md` open questions · Builds on:
ADR 0034, ADR 0035, ADR 0036, ADR 0038

## Context

ADR 0036 shipped the CRM's data, API and agent tools (#332–#338, #343) and left four things open.
The founder decided them on Nov 16, 2026:

1. **Web screens now**, built from Mobbin references, not Figma. He will redesign them later.
2. **No imports in v1** (CSV, Attio).
3. **Mail activity sharing is native to Mail and CRM**, not a separate feature: a mailbox owner
   chooses to show the workspace their activity with a client, and the CRM shows it.
4. **Mail and Storage connect by an explicit action**, "Save to drive", never by syncing.
5. **The contract `ended` job** (ADR 0036 decision 6) ships now.

## Decision

### 1. Web screens from references

The CRM screens are built in `apps/web/src/components/crm/` and `lib/crm.ts` (ADR 0035 decision 3)
from Mobbin references for CRM products, with the existing `components/ui` primitives and tokens
(`DESIGN.md`). They are a first version the founder will redesign; the rules that do not depend on
a frame still hold: components only, semantic classes, `skullet` for loading, and no inline
context text. The screens:

- Companies, People and Deals lists; a deal board by stage, dragged to move.
- A record page per company, person and deal: details, timeline, files (the record's folder
  through `/api/storage`), contracts.
- In a conversation, the sidebar shows who the participants are (`GET /api/crm/lookup`) and adds
  a sender in one action (`POST /api/crm/people`).
- Stages in workspace settings, for owners and admins.

Record links (`/crm/people/<id>`, `/crm/companies/<id>`, `/crm/deals/<id>`) exist once these routes
ship; the MCP rows gain their `url` in the same change (ADR 0036, spec "Agents").

### 2. Mail activity sharing

ADR 0036 decision 3 still holds by default: a record shows a member only the mail they can open.
A mailbox can now **share its activity** with the CRM.

| Level      | Teammates see on a record                              |
| ---------- | ------------------------------------------------------ |
| `off`      | Nothing (the default; no row means `off`).             |
| `activity` | Who in the workspace corresponded with them, and when. |
| `subjects` | The same, plus each thread's subject.                  |

- **Who sets it.** A personal mailbox: its owner, and nobody else, admins included. A shared
  inbox: owners and admins (its members already see its mail).
- **Stored by Mail.** A new mail-owned table, `mailbox_crm_sharing` (`mailbox_id` primary key,
  `org_id`, `level`, `updated_by_member_id`, `updated_at`), lands in its own PR before any code
  that reads it (AGENTS.md "Database"). No column is added to `mailboxes`.
- **Read through Mail's door.** Mail gains `sharedActivityWith({ addresses, domains, before,
  limit })` on `forMember`. It returns, per thread in a sharing mailbox of the member's company
  workspace that the member cannot already open: the mailbox (its owner's name, or the shared
  inbox's name), the last message time, its direction (`in` or `out`), and the subject only at
  `subjects`. Never a thread id, url, snippet, body or attachment. A Personal space shares
  nothing, and a session scoped to a company sees only that company's sharing.
- **In the CRM.** The timeline gains an `activity` item kind beside `thread`; a thread the member
  can open is always a `thread`, never also an `activity`. Records gain `lastContactedAt`,
  computed at read time from both. Nothing is stored per viewer, and turning sharing off hides
  the activity on the next read. `crm_fetch` returns the same `activity` items.

### 3. Save to drive

- `POST /api/mail/attachments/:id/save-to-drive` with an optional `parentId` copies one attachment
  into Storage: My files' root by default, or the folder given. It is a copy, made once. Nothing
  is kept in sync, and deleting either side leaves the other.
- The route lives in the mail module's Worker folder (ADR 0035 decision 4: a feature spanning two
  modules is a Worker route, with the module whose screen starts it). It checks the member can
  open the attachment's thread through Mail's door, and writes through Storage's member door,
  so Storage's quota (`storage_full`), naming (a taken name gets a number) and meter apply.
- The web app's attachment menu gains "Save to drive" with Storage's folder picker.

### 4. Contracts end on their own

A daily CRM job marks every `signed` contract whose `expires_on` is before today (UTC) `ended`,
with a `contract_status_changed` event whose `dedupe_key` is `contract_ended:<id>`, so a second
run changes nothing. It is the CRM module's first entry in `apps/worker/src/modules.ts`, written
on the shared Effect helpers (`apps/worker/src/job-effects.ts`, ADR 0038 decision 2), and it
announces `crm.changed` for the contracts it ends.

## Not in v1

- Imports (CSV, Attio). Records are added by hand, from mail, or by an agent.
- Attaching a Storage file to an outgoing email.

## Consequences

- A teammate's sharing is visible to every member of the company. The setting says so where it
  is changed; it is off until its owner turns it on.
- The first CRM screens will change when the founder redesigns them; their routes and the API
  they call will not.
- Storage gains files written by Mail's route, counted against the same quota.

## Rollout

1. This ADR and the spec.
2. `mailbox_crm_sharing`, alone, merged and migrated before step 4.
3. The contract `ended` job.
4. Activity sharing: the setting, Mail's read, the CRM timeline and `lastContactedAt`.
5. Save to drive: the route.
6. Web: the CRM screens, with record `url`s on MCP rows.
7. Web: the conversation sidebar, "Save to drive", and the sharing setting.

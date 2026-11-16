# 0034: Storage, a files module inside every workspace

Date: 2026-11-15 · Status: accepted · Amends: ADR 0015 (metered prices), ADR 0024 (what a
Personal space holds), AGENTS.md "Postgres is an index Purelymail can rebuild" and `DESIGN.md`
"Never invent" (both for this module only)

## Context

Omni started as one inbox and is becoming the cheap, modern set of tools a company runs on, the
way Skiff was: mail first, then the modules around it. The next module is file storage: what
Dropbox or Skiff Drive do, with a private side and a shared side, living inside the workspace
people already have (ADR 0008, ADR 0024) instead of in a second product with its own accounts.

We already run everything it needs: R2 holds mail objects with no download fees, the Worker
serves them, Better Auth knows who is in which workspace, and Stripe bills the workspace.

Four things were decided by the founder on Nov 15, 2026, and shape the rest: one shared drive
per company (not team drives), sharing by email works for people outside Omni by having them sign
in with that address, storage is metered in Stripe from the start, and the web UI is built now
from Mobbin references without waiting for Figma frames.

## Decision

### 1. Storage is a module of the workspace, with two spaces

Every workspace has Storage. Nothing is created to turn it on: the two spaces are implied by
rows that already exist.

| Space        | Exists in                   | Who reads                   | Who writes                                           |
| ------------ | --------------------------- | --------------------------- | ---------------------------------------------------- |
| **My files** | Every workspace, per member | That member only            | That member                                          |
| **Shared**   | Company workspaces only     | Every member of the company | Every member; trash: the uploader, owners and admins |

- A Personal space (ADR 0024) has one member, so it has My files and no Shared.
- **My files is private.** Owners and admins cannot list or open another member's files, and
  the API has no route that could. This is stricter than mailboxes (ADR 0017).
- **A company keeps its files when someone leaves.** Removing a member moves their My files in
  that company into a folder `Files from <name>` in the My files of whoever removed them (the
  workspace owner when they left by themselves). The move is by `owner_member_id`, in one
  transaction, and a no-op when run twice. Files in their Personal space are untouched.
- Deleting a workspace deletes its rows by cascade; a sweeper then deletes the `orgs/<orgId>/`
  prefix from the bucket, and can be run again.

### 2. Data model

One new schema file, `packages/db/src/schema/storage.ts`. Every table has `org_id`.

| Table             | Columns                                                                                                                                                                                               | Notes                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `storage_nodes`   | id, org_id, space (`personal` \| `shared`), owner_member_id, parent_id, kind (`folder` \| `file`), name, size, mime_type, r2_key, share_id, link_access, created_by_member_id, timestamps, trashed_at | A folder tree. `parent_id` null is the space's root. Among live siblings a name is unique, case-insensitively.  |
| `storage_grants`  | id, org_id, node_id, email, role (`viewer` \| `editor`), created_by_member_id, created_at                                                                                                             | Unique on (node_id, email). The grantee is an address, not a user, so a grant can exist before the person does. |
| `storage_uploads` | id, org_id, member_id, space, parent_id, name, size, mime_type, r2_key, r2_upload_id, parts, node_id, expires_at                                                                                      | An upload in progress. `node_id` is set when it completes, which makes completing twice return the same file.   |
| `storage_usage`   | org_id, bytes                                                                                                                                                                                         | One row per workspace, changed in the same transaction as the node it counts.                                   |
| `storage_peaks`   | org_id, period_start, peak_bytes                                                                                                                                                                      | The most a workspace stored in a usage month (decision 7).                                                      |

- There is no drives table. A drive is `(org_id, space, owner_member_id)`.
- The object key is `orgs/<orgId>/<fileId>`, a random id. The name is not in the key, so rename
  and move change one row and never touch R2. Files are not deduplicated: deleting a file deletes
  exactly its own object.
- A name that is taken gets a number, `report (1).pdf`, in the insert itself.
- Folder depth is capped at 32, so the ancestor walk that access checks need is bounded.

### 3. One access path, three doors

Routes never query the storage tables. Access is decided in `packages/db/src/storage.ts`, and a
node is reachable through exactly one of:

1. **Member**: `db.forMember(memberId).storage`. Reaches the member's own My files and, in a
   company, Shared. The org must be the member's org, as for mail (ADR 0005).
2. **Grant**: `db.forUser(userId, scope).storage`. Reaches a node when the node or one of its
   ancestors has a grant for an address the user has verified (ADR 0014). This is what
   "Shared with me" lists, across workspaces.
3. **Link**: `publicStorageNode(shareId)`. Reaches a node when the node or an ancestor has that
   `share_id` and `link_access = 'anyone'`. No session.

A grant or link on a folder covers everything inside it. The effective role is the strongest one
found on the way up. A trashed node, or one inside a trashed folder, is reachable by nobody but
its space's members.

**Session scope (ADR 0024 decision 3) applies to grants.** A session scoped to a company sees
only grants addressed to an address on that company's claimed domains. An unscoped session sees
grants to every address the person has verified. So whoever controls acme.com's mail still
reaches only what was sent to acme.com addresses.

### 4. Sharing has two modes, like Google Drive

Anything in My files or Shared can be shared, a file or a folder, by whoever can write it.

- **Add people.** Type an address and pick Viewer (list and download) or Editor (also upload,
  create folders, rename, move and trash inside it). This writes a `storage_grants` row and
  sends one system mail with the item's link (ADR 0020). A person who is not on Omni yet signs in
  with that address by magic link, which creates their account and Personal space as sign-up
  already does (ADR 0018, ADR 0024), and finds the item under Shared with me. Where
  `SIGN_UP=invitation`, a grant is not an invitation: it works only for people who can already
  sign in.
- **General access.** `Restricted` (only people added) or `Anyone with the link`. Anyone with
  the link can list and download, never write: an anonymous editor is an open upload endpoint.

There is one link per item, `/s/<share_id>`, and it is the same link in both modes; the mode
decides who it opens for. `share_id` is 22 base64url characters from a CSPRNG, made the first
time an item is shared, never derived from anything. Switching back to Restricted closes a leaked
link at once; "Reset link" makes a new `share_id` and the old link opens nothing.

Removing someone, or changing their role, is immediate: every request checks the grant.

### 5. Files go through the Worker, into their own bucket

A new R2 binding, `STORAGE_BUCKET` (`omni-storage`), separate from `MAIL_BUCKET`. Mail objects
can be rebuilt from the mail host; these cannot, so they get their own bucket, lifecycle and
backup story.

- **Upload** is R2 multipart through the Worker's binding, one code path for every size:
  `POST /api/storage/uploads` checks the quota and opens the upload, the client sends 16 MiB
  parts to `PUT /api/storage/uploads/:id/parts/:n`, each streamed into R2, and
  `POST /api/storage/uploads/:id/complete` closes it, inserts the node and adds its size to
  `storage_usage` in one transaction. A part can be re-sent, parts can go in parallel, and a
  dropped connection resumes from the parts the row already lists. An upload nobody completes is
  aborted by the existing every-minute cron after 24 hours.
- **Why not presigned URLs straight to R2:** they need S3 credentials in the Worker and CORS on
  the bucket, neither of which the Worker has today, and a self-hoster would have to set up both.
  Streaming a body through a Worker costs no CPU time to speak of. Revisit when it limits us.
- **Download** streams from R2 through the Worker and honors `Range`. Every file is served as
  `application/octet-stream` with `content-disposition: attachment` and `nosniff`, whatever its
  type. There is no preview in v1, and nothing a person uploaded ever renders on our origin.
- `STORAGE_MAX_FILE_BYTES` caps one file (default 5 GB).
- **Trash.** Delete moves a node to Trash (`trashed_at`); it can be restored for 30 days, then
  the daily cron deletes the rows, subtracts the bytes and deletes the objects, rows first.
  Trashed files count toward usage until then. "Delete forever" does the same at once.

### 6. API

All under `/api/storage`, on the Worker. Member routes use the active workspace.

| Route                                                                                                | Does                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /nodes?space=&parent=`                                                                          | Lists a folder: folders first, then by name. Cursor paged.                                                                   |
| `POST /folders`                                                                                      | Creates a folder.                                                                                                            |
| `PATCH /nodes/:id`                                                                                   | Renames, or moves within the same workspace.                                                                                 |
| `DELETE /nodes/:id` · `POST /nodes/:id/restore`                                                      | Trash and restore. `DELETE ?forever=1` from Trash deletes for good.                                                          |
| `GET /trash`                                                                                         | What the member may restore.                                                                                                 |
| `POST /uploads` · `PUT /uploads/:id/parts/:n` · `POST /uploads/:id/complete` · `DELETE /uploads/:id` | Upload (decision 5).                                                                                                         |
| `GET /files/:id/content`                                                                             | Download.                                                                                                                    |
| `GET /nodes/:id/sharing` · `PUT /nodes/:id/sharing/link`                                             | Who has access; set general access or reset the link.                                                                        |
| `PUT /nodes/:id/sharing/people/:email` · `DELETE` the same                                           | Add a person or change their role; remove them.                                                                              |
| `GET /shared-with-me`                                                                                | Grants to the signed-in person, across workspaces.                                                                           |
| `GET /shared/:shareId` · `GET /shared/:shareId/files/:id/content`                                    | The link door: metadata, a folder's contents, download. A session is optional; with one, a grant can open a Restricted link. |
| `GET /usage`                                                                                         | Bytes used, the allowance, and whether uploads are blocked.                                                                  |

Types live in `@omni/contracts`. New rate limits, each `<count>/<seconds>` like the others:
`RATE_LIMIT_STORAGE_SHARE` (mail sent by adding people, per member) and
`RATE_LIMIT_STORAGE_LINK` (link-door requests, per IP).

### 7. Limits and billing

Storage is the first thing in Omni whose cost grows with use and has no natural ceiling, so
ADR 0015's "metered prices are deliberately absent" ends here, for storage only. Triage stays
an allowance.

- **A company on the plan** gets `BILLING_STORAGE_INCLUDED_GB` included, and pays per extra GB
  per month beyond it. The price is a metered Stripe price (`STRIPE_PRICE_STORAGE`) on a Stripe
  meter, added as a second item to the workspace's one subscription. No amount is in code.
- **What is billed is the peak.** The daily cron takes each billed workspace's `storage_usage`,
  raises `storage_peaks` for the current usage month (`usagePeriod`, as for triage) if today is
  higher, and reports the peak's whole GB above the allowance to the meter, which aggregates with
  `last`. Sending the same value twice bills nothing extra, a missed day is repaired by the next,
  and deleting everything the day before the invoice saves nothing. A customer reads it as "the
  most you stored this month".
- **No overage without a card.** A trialing workspace, or one with no payment method, is capped
  at the included allowance: uploads past it answer `402 STORAGE_FULL`.
- **A Personal space** is free and can never start a plan (ADR 0024), so it has a hard cap,
  `STORAGE_PERSONAL_GB`. Past it, uploads answer `402 STORAGE_FULL`.
- **`STORAGE_MAX_GB`**, optional, is a ceiling per workspace that nothing passes, so a runaway
  script cannot run up a bill.
- **A read-only workspace** (ADR 0015) keeps listing, downloading and serving its links; uploads
  and every change answer `402 BILLING_INACTIVE`. Nothing is deleted for not paying.
- **Billing off** (self-hosted): no allowance and no meter. Only `STORAGE_PERSONAL_GB` and
  `STORAGE_MAX_GB` apply, and only when set.
- Quota is checked when an upload opens, counting the declared sizes of uploads in progress, and
  again when it completes. `storage_usage` is recomputed from `storage_nodes` by the daily cron,
  so a drifted counter is wrong for a day at most.

The meter, its price and the allowance are made in Stripe by a founder, as ADR 0015 already
says for the plan.

### 8. Web UI, from references

The module needs screens before Figma has them. For Storage only, the web app is built from the
existing `components/ui` primitives, laid out after the references below, and reconciled with
Figma when its frames exist. Every other `DESIGN.md` rule holds: tokens only, Central icons, an
icon on every menu item, `skullet` for loading, and the ban on inline context text.

| Screen                                                                                                        | Built from                                                                  | Reference                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File list: Name, Modified, Size; breadcrumbs; New folder and Upload at the top right; drop anywhere to upload | `table`, `breadcrumbs`, `drop-zone`, `file-trigger`, `menu`, `progress-bar` | [Proton Drive](https://mobbin.com/screens/67e7d931-a0e6-40c6-8a9f-183a218daed9), [ElevenLabs Files](https://mobbin.com/screens/666432ed-a153-4e58-b125-2dd0c9daa7ef) |
| Sidebar: My files, Shared, Shared with me, Trash                                                              | `nav-list`                                                                  | [Proton Drive](https://mobbin.com/screens/67e7d931-a0e6-40c6-8a9f-183a218daed9)                                                                                      |
| Share dialog: address and role, then who has access, then general access with Copy link                       | `dialog`, `text-field`, `select`, `avatar`, `copy-field`                    | [Figma](https://mobbin.com/screens/699986ad-3b3d-4488-b6bd-c3ea89600abf), [Gamma](https://mobbin.com/screens/09a3d809-1ea1-4997-9f95-fbdac0be3610)                   |
| Link page `/s/:shareId`: the name, the size, Download; a folder lists its contents                            | `card`, `button`, `table`                                                   | [Salesforce](https://mobbin.com/screens/3e638e9d-7a1b-49ea-aded-b1f2a4e6f434)                                                                                        |

Usage shows as a `meter` in Settings → Billing beside triage usage, not in the sidebar.

## Not in v1

- **Previews and thumbnails.** Download only.
- **End-to-end encryption.** Skiff Drive had it; Omni's files are encrypted at rest by R2 and
  readable by the server, which is what makes links, grants and (later) search possible. It is
  its own ADR if we want it.
- Team drives, folder download as a zip, versions, comments, search inside Storage, realtime
  list updates (lists refetch), link passwords and expiry, moving between workspaces, the iOS
  app and the MCP server. The API is shaped so each can be added without changing what exists.

## Rollout

Each layer is additive and one PR in a stack; nothing changes for mail.

1. This ADR.
2. `@omni/db`: schema, migration, the three doors, usage counting. E2E in `packages/db`.
3. Worker: `STORAGE_BUCKET`, folders, upload, download, trash, the crons. E2E in `apps/worker`.
4. Worker: grants, links, the link door, share mail, session scope, member removal.
5. Billing: allowance, caps, peaks, the Stripe meter.
6. Web: the four screens. `docs/self-hosting.md` gains the bucket and the variables.

## Verification

E2E against the local stack (real Postgres, real workerd with its local R2), each named for the
bug it catches:

- A 40 MiB file uploaded in three parts downloads byte-identical; a `Range` request returns the
  right slice; completing twice makes one file and counts its bytes once.
- A member cannot list, download or share another member's My files, and an admin cannot either.
- A grant on a folder opens a file two levels down for that address and for no other; removing
  the grant closes it on the next request.
- A Restricted link answers `404` without a session; switched to Anyone it downloads; reset, the
  old link answers `404`.
- A session scoped to a company does not see a grant addressed to the person's personal address.
- An upload that would pass the cap answers `402` and stores nothing; purging Trash frees the
  bytes; a read-only workspace still downloads.
- Removing a member leaves their files reachable by the admin who removed them.
- Live, in Stripe test mode: the daily job run twice for one workspace bills its peak once.

To confirm while building layer 5, from Stripe's docs and a test clock, not assumed here: that a
monthly metered item can sit on a yearly subscription (mixed intervals), and how a `last` meter
closes a period with no event in it. If a yearly plan cannot carry the item, yearly workspaces
are capped at the allowance until it can, and this ADR is amended.

## Consequences

- **Storage rows are the truth, not an index.** A lost `storage_nodes` row loses a file even
  though its bytes are in R2. Database backups now protect customer data, not just save a
  re-sync, and the bucket must never get a lifecycle rule that expires objects.
- **Public links on our origin are an abuse surface**: free Personal spaces can sign up and share
  files with anyone. v1 answers with attachment-only responses, the personal cap and the link
  rate limit. A way to report and take down a link is the first follow-up once links are live.
- Sign-ups can now start from a share mail, so abandoned-sign-up cleanup (ADR 0018) must keep an
  account that holds a grant.
- Worker request size limits cap a part, not a file; 16 MiB parts fit every Cloudflare plan.
- New config, all optional with neutral defaults: `STORAGE_BUCKET` (binding),
  `STORAGE_MAX_FILE_BYTES`, `STORAGE_PERSONAL_GB`, `STORAGE_MAX_GB`,
  `BILLING_STORAGE_INCLUDED_GB`, `STRIPE_PRICE_STORAGE`, `STRIPE_STORAGE_METER_EVENT`,
  `RATE_LIMIT_STORAGE_SHARE`, `RATE_LIMIT_STORAGE_LINK`. With billing on, the three billing ones
  are required together or not at all.
- Packages touched: `@omni/db`, `@omni/contracts`, `@omni/worker`, `@omni/auth` (the subscription
  item), `apps/web`. `apps/mail`, `mail-core`, `ai` and `crypto` are not.

## Amendment: limits and billing as built (2026-11-16)

Layer 5 settled what decision 7 left open:

- **Yearly plans are capped at the allowance for now.** The storage price is monthly. A yearly
  subscription can carry it only in Stripe's flexible billing mode, which existing subscriptions
  cannot leave once migrated, and which Checkout cannot create with mixed intervals. A yearly
  workspace gets no metered item and no meter events, and uploads past the allowance answer
  `402 STORAGE_FULL`, like a trial. A workspace whose subscription has a schedule is capped the
  same way, because a schedule rewrites its items.
- **Who passes the allowance:** a company whose subscription is `active` or `past_due`, monthly,
  and that Stripe showed with a payment method. A new table, `storage_overage`, records which
  subscription that was. Stripe's webhook sets it when a subscription event carries a
  `default_payment_method`, and the daily job sets or clears it from the subscription and its
  customer, so no request calls Stripe. Billing on with the three storage variables unset means
  no allowance and no meter: only `STORAGE_MAX_GB` applies.
- **The period is `usagePeriod`.** For a monthly plan this is the subscription's own period,
  which on a classic subscription is also the metered item's period, so a peak and Stripe's
  `last` value cover the same month. The job runs once a day (`47 3 * * *`), so growth after
  the last run before a period ends is not billed.
- **Rounding is down.** What is reported is `floor((peak − allowance) / 1 GB)`: an extra GB is
  billed once it is full.
- **The item** is added by the daily job (`proration_behavior: none`) the first time a paying
  monthly workspace's peak passes the allowance, before that day's event. A classic subscription
  bills only usage reported after the item was added. While the item is on, an event is sent
  every day, `0` included, with an identifier derived from workspace, period, day and value. The
  item is removed again a week into a period whose peak stays under the allowance, by which time
  the period before has been invoiced. While it is on, Stripe's customer portal can cancel the
  subscription but not change it, so switching monthly to yearly waits until the item is gone.
- **A read-only workspace keeps its Trash.** The daily purge skips workspaces not in good
  standing, because restoring is a write they cannot make. What was due goes with the first
  purge after the workspace pays again.

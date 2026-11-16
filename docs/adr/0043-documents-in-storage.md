# 0043: Documents live in Storage: versions, editing, comments, signing

Date: 2026-11-16 · Status: accepted (decision 1 built here; 2 to 8 are the direction, each
checked again when it is scheduled) · Amends: ADR 0034 ("Not in v1": versions, comments), ADR 0037
(where signing lives), ADR 0040 (Office formats)

## Context

Skiff had Pages next to Drive, and Claude has documents: a place where a team writes together.
The founder wants that inside Storage itself, not as a second module: a document is a file in the
same tree, with the same grants, links, Trash and billing as any other file, and every file type
can be stored beside it. On top of the tree come the things a working drive needs: versions,
editing in place, live collaboration, a code and sheet viewer, annotations, and signing.

The founder decided the eight points below on Nov 16, 2026, chose S2 for the live layer, and asked
for the web UI to be built with the work instead of waiting for Figma frames (as ADR 0034
decision 8 did).

What is deliberately not here: a block editor, a formula engine, or Notion-style databases. The
CRM (ADR 0036) is Omni's structured-records module; Storage does not grow a second one.

## Decision

### 1. Every file has versions (built here)

Saving new content over a file keeps the content it replaces. One mechanism serves a re-upload
today and an editor's save, an agent's write and a restore later.

- Three new tables and no change to an existing one, so the Worker from before this change
  keeps reading `storage_nodes` and `storage_uploads` beside them (they land in a PR of their
  own, ahead of the code):
  - `storage_versions` (id, org_id, node_id, size, mime_type, r2_key, written_by_member_id,
    written_at, replaced_at): one row per **replaced** content. The node still carries the
    current content (`size`, `mime_type`, `r2_key`), so every read path that exists is unchanged.
  - `storage_contents` (node_id, org_id, written_by_member_id, written_at): who wrote the
    current content and when, once it has replaced an earlier one. No row means "as created".
  - `storage_upload_targets` (upload_id, org_id, node_id): the file an upload is a new version
    of. Deleting the file leaves the row with `node_id` null, so a replacement whose target is
    gone is refused instead of completing as a new file.
- A new version is an upload with a target. Opening it is one new route; sending parts, resuming
  and completing are the routes that already exist. Completing it moves the node's current
  content into `storage_versions` and points the node at the new object, in the transaction that
  counts the bytes. Completing twice returns the same file.
- The object key stays `orgs/<orgId>/<random id>`: a new version is a new object, and nothing
  is copied or rewritten in the bucket.
- **Who:** whoever may edit the file: a member who reaches it, or a person with an Editor grant
  on it or on a folder above it. A viewer and a link see only the current content and never the
  list of versions: what an editor replaced may be what they meant to take back.
- **Restore** makes a kept version the current content again, and the content it displaces
  becomes a version. It is a swap of rows; no bytes move.
- **A locked file (ADR 0036 decision 6) takes no new version and no restore.** A signed contract
  is the bytes that were signed.
- **Retention:** a replaced version is kept 30 days from the moment it was replaced, as Trash
  is, then the daily job deletes it, rows first. A version goes with its file when the file is
  deleted for good.
- **Billing:** versions are bytes the workspace stores. They count toward usage, the quota and
  the metered peak (ADR 0034 decision 7) until they are purged, exactly as trashed files do.

### 2. A document is a Markdown file

A document is a `.md` file in the tree. The editor is limited to what Markdown round-trips, and a
save is a new version (decision 1). There is no second, opaque document format: an agent, `git`,
a self-hoster and any other editor read and write the same bytes. Plain text and code files are
edited through the same path.

### 3. Collaboration in two steps

1. **Checked saves.** A save names the content it was based on; when the file has
   moved on, the save is refused with the newer content's identity and the editor merges or asks.
   Presence ("Ana is editing") rides the existing realtime channel.
2. **Live co-editing on S2.** An open document is one S2 stream of editor updates; the Worker
   mints a short-lived, stream-scoped token for whoever may edit the file, and folds the stream
   back into a Markdown version on idle. S2 is a durable, ordered, replayable log, which is the
   hard part of this, and it is cheap at our size. Self-hosting holds: `s2-lite` is the MIT
   server of the same API and runs against the S3-compatible bucket a self-hoster already has.
   The live layer is optional config (`S2_*`); without it a document still edits with step 1.

### 4. Annotations are rows, never bytes

A comment is a row in Postgres with an anchor (a PDF page and region, a line range, a cell, or
the whole file) and the version it was made on. Nothing is written into the file, so one model
covers every viewer and a signed file is never touched by a comment.

### 5. A commenter role

`storage_grant_role` gains `commenter` between `viewer` and `editor`: reads, and writes comments.
People outside Omni can hold it, as with any grant.

### 6. Signing is a Storage primitive

ADR 0037's simple electronic signature is built in Storage: a signature is made on one locked
version of a PDF, by an address, and recorded as rows. The CRM's contracts use it; any file can.
ADR 0037's client dashboard is unchanged.

### 7. Viewers

Code and CSV render today (ADR 0040). XLSX gets a view-only renderer in the client, loaded on
demand, under ADR 0040's rule: parsed as data, shown as text cells, never as a document on our
origin. DOCX and PPTX stay download-only.

### 8. No cold storage yet

R2's Infrequent Access class is a bucket lifecycle rule, not code. Its saving is on storage
alone, with a retrieval fee and a minimum duration, and previews, thumbnails and (later) search
re-read old files. Revisit with real usage numbers; a self-hoster can set the rule today.

## Order

Versions (here) → in-place editing of Markdown and text with checked saves → comments and the
commenter role → live co-editing → signing. The XLSX viewer is independent.

## Open

"Multi-file" was asked for and not yet defined: several tabs in one document, or several files
edited side by side. Decision 2 assumes one file is one document; tabs would be a folder shown
as one document, decided when editing is built.

## Consequences

- The quota can fill with content nobody sees in the list. The file's version list shows what
  each kept version weighs, and usage recounts include them.
- A bucket object is now owned by a node **or** a version. Every path that deletes a file
  returns its versions' keys with it.
- Worker code from before this change deletes a file's rows (versions cascade) but not its
  versions' objects, and its daily recount leaves versions out. Both can only happen in the
  minutes a deploy overlaps: the objects are orphaned bytes, and the next recount corrects the
  number.
- Agents get versions for free when Storage reaches the MCP server (ADR 0029): an agent's write
  is a version a person can restore.
- S2 becomes a second place document content passes through, for the live layer only. The
  Markdown file in Storage stays the truth; a lost stream loses at most the edits since the last
  fold.

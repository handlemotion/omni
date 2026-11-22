# Omni docs: Drive's own documents

Nov 21, 2026 · Draft for review · Extends `docs/spec/v1.md` and `docs/spec/mcp.md` ("Docs")

## Summary

A doc is an Omni document, not a Markdown file that happens to open as a page. It has its own
type, a name with no extension, its own icon in Drive, and a page editor in the spirit of Google
Docs, but simpler: blocks instead of rulers, indents and page setup. It leaves Omni through
Export (Word, PDF, Markdown), not through Download.

Docs are the first of Omni's own file types. Sheets and canvases follow the same pattern: a type
of their own, an editor of their own, exports to the formats other tools read.

## What changes

| Before                                         | Now                                                         |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `Untitled.md`, `text/markdown`                 | `Untitled`, type `text/vnd.omni.doc`                        |
| Shown with the code glyph, badge `MD`          | Doc glyph, badge `DOC`                                      |
| Formatting from the `/` menu and a bubble bar  | Also a toolbar floating at the bottom of the page           |
| Download gives the `.md` file                  | Export: Word, PDF, Markdown, or copy as Markdown            |
| `drive_create_doc` names it `<name>.md`        | `drive_create_doc` names it `<name>`, type `text/vnd.omni.doc` |

## The type

- An Omni doc is a Drive file whose type is `text/vnd.omni.doc` (`DOC_TYPE` in `@omni/docs`).
  The type, not the name, makes it a doc, so names carry no extension.
- Its body stays Markdown. Search, `drive_fetch`, versions, the live document, desktop sync and
  self-hosting read it as text with no new code path, and Postgres stays an index the bucket can
  rebuild. The type starts with `text/`, so text extraction reads it as plain text.
- Markdown files people upload (`.md`, `.markdown`) still open as docs, but keep their name,
  their type and their Download. `isDocFile(name, type)` answers both cases, and
  `isOmniDoc(type)` only the first. Every place that asks "is this a doc" uses them: the web app,
  the Worker's doc tools and, inline, `@omni/db`'s rule that pasted images belong to their doc.
- A new version keeps the file's type. Saving from the editor sends the node's own type, and
  the Worker's doc writes pass the node's type through (`writeText`, `refusalFor`).
- Expand and contract: no migration. Existing `.md` docs stay as they are and keep working.
- **Convert to Omni doc**, from a Markdown file's ⋯ menu or a selection's bar, turns one into an
  Omni doc on request: its text is saved as the next version with the doc type (the Markdown
  file stays in Versions), then `.md` leaves its name. Nothing converts on its own: some `.md`
  files are meant to stay Markdown (READMEs, notes synced from a Mac).

## The editor

The page is the editor that exists (`apps/web/src/components/storage/editor`): Tiptap on the
shared schema in `@omni/docs`, live through Yjs. This spec adds:

- **Toolbar.** Floating at the bottom of the page, always there while editing: text style
  (Text, Heading 1-3), bulleted list, numbered list, to-do list, table, image, dropdown, more
  (quote, code, divider) and comment on the selection. In a table, the table button becomes the
  table's menu: rows (add above, add below, delete), columns (add left, add right, delete), header
  row, delete table.
- **Dropdowns.** A line that opens to show the blocks under it, open or closed for everyone
  (the state is part of the doc). In Markdown it is the HTML GitHub and most readers fold:

  ```markdown
  <details>
  <summary>The line</summary>

  The blocks inside.

  </details>
  ```

  `<details open>` when it is open. Dropdowns nest.
- **No indent model.** Lists nest with Tab, nothing else indents. No rulers, margins, page size
  or fonts: the page has one layout, and Word and PDF exports lay it out for print.
- **Modes.** The doc bar's mode menu: Editing, or Commenting, where the text is read-only and a
  selection offers only Comment. Opening another file starts it in Editing again.
- The bubble bar over selected text (bold, italic, strikethrough, code, comment), the `/` menu
  (which gains Dropdown) and the block handle stay.

## The live document

Everyone editing a doc types into one live document: a Yjs document kept as an S2 stream of
records (`docs/<nodeId>`, `@omni/contracts` `storage-live.ts`), saved to the file as its next
version a moment after the typing stops.

- **Snaps.** Each record is a change of a few keystrokes, so a doc edited for weeks has a long
  stream. Every `STORAGE_LIVE_SNAP_EVERY` (200) records, the editor whose change crossed the mark
  appends a `snap`: the document's whole state through a record, and its latest save. Readers
  (the web editor, and the Worker's doc tools) start at the latest `seed` or `snap`, found in one
  read of the stream's tail (`GET /files/:id/live?from=latest`), not at the stream's first
  record. A doc opens in a few hundred records however long it has been edited, and the basin's
  retention dropping old records no longer takes the epoch with it.
- **Nothing typed is left unsaved.** A change is in the stream about 60 ms after it is typed. Its
  tab saves it as the file's next version 2 s later; when that tab is gone first (closed, lost
  its connection), another tab on the doc saves it after 6–10 s of quiet. Closing a tab sends
  its last keystrokes at once instead of after the 60 ms batch.

## Versions

Every save is a new content version of the file, but not every save is a version people pick
from. Versions follow editing sessions (#706):

- **Sessions.** A member's saves in the app with at most 5 minutes between them, for up to 15
  minutes from the first, are one session (`STORAGE_SESSION_IDLE_MS`, `STORAGE_SESSION_MS` in
  `@omni/db`). Versions keeps the content each session started from; the autosaves in between are
  kept as superseded (`storage_versions.superseded_at`), hidden, and purged by the daily job a day
  later (`STORAGE_SUPERSEDED_MS`). Someone else's save ends the session, and so does a save that
  changes the file's type (Convert to Omni doc keeps the Markdown as a version).
- **Agents.** An agent's write (`drive_create_doc`, `drive_edit_doc`) is always a version of its
  own and never continues a session. It names the agent: `writtenByAgent`, the MCP client's
  registered name, beside `writtenByName`, the person it acted for. Before an agent changes a live
  document it ends the session that wrote the content (`storage_contents.session_ended`), so the
  content from before its change stays restorable whoever saves next.
- Comments and signatures keep the `contentVersion` they were made on.

This is what files of every type get. Omni's own types get History on top of it (next section).

## History

Direction from the owner: a file Omni edits (a doc, and sheets and canvases when they land) is one
canonical document with an edit history, as in Notion's page history, not a pile of file
versions. Files Omni cannot edit (PDFs, images, uploads) keep Versions as above.

### What people see

History replaces Versions for these files. It lists editing sessions, newest first: when, who
wrote in it (people, agents and, once `live-sharing.md` lands, guests), and how much changed
(blocks added, removed, changed). Picking one shows the page as it was at the end of that
session, with what the session changed marked and each change's author named. Restore brings the
page back to it. The look comes from the Figma pass (`DESIGN.md`); the panel has no explanatory
text.

### The change log

- **Every record says who sent it.** The realtime object stamps each record it appends with `by`,
  overwriting whatever the client sent: `m:<memberId>` (and the grantee and guest kinds of
  `live-sharing.md` §7, the same field, whichever of the two ships first adds it). The Worker's
  own appends say `a:<memberId>:<agent>` for an agent's edit and nothing for a fold.
- **The journal is durable; the stream is not.** S2 keeps records until the basin's retention
  drops them, so history cannot be read from it. After each save of a live document (a tab's,
  the orphan save's, the Worker's), a job reads the stream from the last journaled record to the
  save's `s` and writes it to `storage_doc_changes` (`org_id`, `node_id`, `epoch`, `first_seq`,
  `last_seq`, `by`, the author's name and agent at the time, `started_at`, `ended_at`, `update`
  bytea, `content_version` of the save). A row is a **run**: consecutive records by one author,
  merged into one Yjs update, cut at a minute or at the first record by anyone else. Runs keep the
  stream's order, so when two people take turns in one block each turn is a row of its own, and a
  replay applies them in the order they were typed. Unique on `(node_id, epoch, first_seq)`, so a
  job run twice writes nothing new. A write outside the live layer (an upload of a new version, an
  agent edit with nobody editing, a restore) journals one row for its writer, with no update: the
  versions around it already hold both sides.
- **Baselines.** A run's update refers to the Yjs identities of the epoch it was typed in, and a
  document rebuilt from Markdown has new ones, so runs replay only onto Yjs state. The job keeps
  that state in `storage_doc_baselines` (`org_id`, `node_id`, `epoch`, `seq`, `state` bytea): the
  epoch's `seed` when it first journals an epoch (or the `snap` it started from, if the seed is
  gone), and a checkpoint of the merged state every 500 rows after it. A replay starts at the
  latest baseline at or before the runs it needs.
- **Sessions are the journal grouped** by the rule of "Versions" (one author kind, 5 minutes idle,
  15 at most), except that a session in History may hold several people writing together: a
  member's session absorbs the minutes in which others wrote alongside them, and names them all.
  An agent's change is always a session of its own.
- **The page at the end of a session** is the version #706 keeps for it, so History needs no
  second store of whole documents: Versions' objects are its snapshots, and their purge is its
  retention (30 days, `STORAGE_VERSION_DAYS`).

### Diffs and attribution

- `@omni/docs` gains `diffBlocks(before, after)`: the two documents' top-level blocks matched by
  content (a block moved is one move, not a removal and an addition), then each changed block's
  text diffed by word. Pure, in the shared package, so the panel and agents read the same diff.
- **Who changed which block.** Replaying runs in stream order from the latest baseline before the
  session, and diffing blocks before and after each run of the session, names the author of each
  change. Two people typing in one block name both. A session that crosses an epoch (the file
  changed outside the live layer) starts again from the new epoch's seed; the write that ended the
  epoch journaled its own row.

### Restore goes through the live document

Today `POST /files/:id/versions/:versionId/restore` swaps the file's content under people who
have the doc open: their live document still holds the old text, and the next save of anyone
typing is refused, asks "Someone saved a newer version", and Keep mine undoes the restore. For a
file with a live document, restore becomes an edit: the Worker rewrites the live document to the
version's Markdown (`rewriteLive`, as `drive_edit_doc` does), passes it to everyone editing, and
saves it, so open pages show the restored text at once and nobody sees a conflict. The restored
content is a session of its own, by the member who restored it, and the content it replaced stays
in History.

### Agents

`drive_versions` on a file with History lists its sessions (`authors`, block counts) and, with
`version_id`, returns the block diff and its authors alongside the unified text diff. An agent
restores by writing the version's text with `drive_edit_doc { markdown }`, which is already an
edit through the live document.

### Routes and contracts

- `GET /files/:id/history`: `{ sessions: [{ id, startedAt, endedAt, authors: [{ kind, name,
  agent }], contentVersion, restorable, versionId }], keepDays }`, newest first. Editors only,
  like Versions. Block counts come with a session's diff, not the list, which reads no content.
- `GET /files/:id/history/:sessionId`: the session's page and its block diff with authors.
- Restore: each session carries `versionId`, the version holding its page (null when it is the
  file's content now), restored with `POST /files/:id/versions/:versionId/restore`, which edits
  the live document as above. History has no restore route of its own.
- Expand only: `by` is optional on records, old tabs ignore it, and Versions' routes stay for the
  files that keep them.

### In order

1. Restore through the live document, and `by` on every record (no migration).
2. `storage_doc_changes`, `storage_doc_baselines` and the journal job.
3. `diffBlocks`, the History routes and `drive_versions` sessions.
4. The History panel in `apps/web`, from its Figma frame.

Sheets and canvases take this unchanged when they land; a sheet's diff compares cells by row and
column id (`docs/spec/sheets.md`, "History").

## Export

A doc's header shows Export in place of Download: one menu, in sections.

- **Download:** Word (`.docx`), PDF (the print dialog, Save as PDF) and Markdown (`.md`).
- **Copy:** Copy as Markdown.

Exports read the doc as the editor holds it now, unsaved typing included. The file's row menu
offers Export as PDF, Word and Markdown, and no raw Download for an Omni doc (its file has no
extension). Everything is done in the browser; nothing new runs on the Worker.

## Shared links

A doc shared through a link opens as the same page, for people outside the workspace too, with
what the link's role allows:

| Role      | Page                                                                    |
| --------- | ----------------------------------------------------------------------- |
| Editor    | Editing (or Commenting), toolbar, saves through the link's door          |
| Commenter | Read-only text; a selection offers Comment; the toolbar shows comments  |
| Viewer    | Read-only text, no toolbar, no comments                                 |

Share holds Export only when the link allows downloads. Read-only pages never save, and the
page asks for versions and comments only when the role may read them. Outside editors save
version by version: they don't join the live document yet.

Next, in `docs/spec/live-sharing.md`: a link gets a role of its own (Viewer by default,
Commenter or Editor for docs), and outside editors and commenters, signed-in grantees and
guests alike, join the live document through a socket opened by the link's door. Their role is
checked on every append, a revoked link closes their socket within seconds, the Worker saves
their typing, and versions name them.

## Agents

`drive_create_doc` writes an Omni doc: its name as given, with no `.md`. `drive_edit_doc` edits
Omni docs and Markdown files alike and keeps each one's type. Its Markdown may hold dropdowns as
`<details>` blocks.

## Not in this change

- Sheets (`text/vnd.omni.sheet`, `docs/spec/sheets.md`) and canvases (`text/vnd.omni.canvas`,
  `docs/spec/canvas.md`), each with its own type and spec.
- Desktop sync names Omni docs as Drive does, with no extension, so Finder does not know to open
  them as Markdown. Next: the File Provider shows an Omni doc as `<name>.md` and maps that name
  back on rename.
- Live co-editing for people outside the workspace, specified in `docs/spec/live-sharing.md`.
  The live document's realtime socket and its `doc.append` checks are per workspace member
  (`realtime.ts`, `realtime-docs.ts`). Until that spec ships, an outside editor's save is a new
  version, and members editing live reopen on it.
- Ask Claude from the toolbar.

## Verify

- `apps/worker/e2e/drive-docs.e2e.test.ts`: an agent's doc is named without `.md`, has the doc
  type, and keeps it after an edit; an image pasted into an Omni doc belongs to it.
- On the stack: a new doc is `Untitled` with the doc glyph; the toolbar adds each block; a
  dropdown survives a save and a reload; Export downloads Word, PDF and Markdown, and copies.

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

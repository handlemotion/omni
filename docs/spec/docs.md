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
version by version: they don't join the live document yet (next).

## Agents

`drive_create_doc` writes an Omni doc: its name as given, with no `.md`. `drive_edit_doc` edits
Omni docs and Markdown files alike and keeps each one's type. Its Markdown may hold dropdowns as
`<details>` blocks.

## Not in this change

- Sheets (`text/vnd.omni.sheet`, `docs/spec/sheets.md`) and canvases, each with its own type and
  spec.
- Desktop sync names Omni docs as Drive does, with no extension, so Finder does not know to open
  them as Markdown. Next: the File Provider shows an Omni doc as `<name>.md` and maps that name
  back on rename.
- Live co-editing for people outside the workspace. The live document's realtime socket and its
  `doc.append` checks are per workspace member (`realtime.ts`, `realtime-docs.ts`); a link's
  editor needs a socket opened through the link's door, its role checked per append, and a
  presence identity of its own. Until then an outside editor's save is a new version, and members
  editing live reopen on it.
- Ask Claude from the toolbar.

## Verify

- `apps/worker/e2e/drive-docs.e2e.test.ts`: an agent's doc is named without `.md`, has the doc
  type, and keeps it after an edit; an image pasted into an Omni doc belongs to it.
- On the stack: a new doc is `Untitled` with the doc glyph; the toolbar adds each block; a
  dropdown survives a save and a reload; Export downloads Word, PDF and Markdown, and copies.

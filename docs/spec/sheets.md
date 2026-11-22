# Omni sheets: Drive's own spreadsheets

Nov 22, 2026 · Draft for review · Extends `docs/spec/docs.md` and `docs/spec/mcp.md` ("Docs");
builds on the live layer of #705 (snaps), #706 (versions by editing session) and #707
(`drive_versions`)

## Summary

A sheet is Omni's second file type: a grid of tabs, rows and columns that a team edits together,
live, the way they edit a doc. It has its own type, a name with no extension, a page editor, and
leaves Omni through Export (Excel, CSV), not Download. Agents create and edit it with cell and
range edits that merge into what people are typing, as `drive_edit_doc` does for docs.

A sheet is one canonical file. Its history is the file's history (one version per editing
session, one per agent edit), not a pile of copies: importing, exporting and agent edits never
leave a second file behind.

## What it is, and what it is not

| A sheet is                                            | A sheet is not                                         |
| ----------------------------------------------------- | ------------------------------------------------------ |
| A Drive file, shared and found like any other         | A CRM list: no records, owners, stages or doors of its own |
| A grid with typed columns, formulas and saved views   | Excel: no charts, pivots, macros, styling per cell     |
| Edited live by members and their agents               | A database: tens of thousands of rows, not millions    |
| Exported to `.xlsx` and `.csv` on request             | A converter that keeps an `.xlsx` in sync              |

## The type

- An Omni sheet is a Drive file whose type is `text/vnd.omni.sheet` (`SHEET_TYPE`, `isOmniSheet`
  in a new `@omni/sheets`), the type `docs.md` already reserved. Names carry no extension.
- No migration. The type is a string on the node, as the doc type is.
- `.xlsx` and `.csv` files people upload keep their name, type and Download. **Convert to Omni
  sheet**, from their ⋯ menu, turns one into a sheet on request, as Convert to Omni doc does:
  the converted body is saved as the file's next version with the sheet type, the original stays
  in Versions, and the extension leaves its name. Nothing converts on its own.

## The stored format

The file's body is **JSON Lines**: one header line, then one line per row, in order.

```jsonl
{"omni":"sheet","v":1,"tabs":[{"id":"t7Qk","name":"Leads","frozen":{"rows":1,"cols":0},"columns":[{"id":"c1aZ","width":180},{"id":"c9Pm","type":"number","format":{"kind":"currency","currency":"MXN","decimals":2}},{"id":"c3Lx","type":"select","options":["Lead","Won","Lost"]},{"id":"c0Rt","type":"number"}],"views":[{"id":"vB2e","name":"Won","filter":[{"col":"c3Lx","op":"is","value":["Won"]}],"sort":[{"col":"c9Pm","dir":"desc"}]}]}]}
{"t":"t7Qk","r":"r8f2","c":{"c1aZ":"Company","c9Pm":"Amount","c3Lx":"Stage","c0Rt":"With tax"}}
{"t":"t7Qk","r":"rc41","c":{"c1aZ":"Acme","c9Pm":1200,"c3Lx":"Won","c0Rt":{"f":"=B2*1.16","v":1392}}}
```

- **Ids.** Every tab, row and column has a short random id, unique in the sheet. The file's order
  is the sheet's order; ids are what stay put when rows move, so versions, history and agents can
  say "this cell" across inserts and sorts.
- **Empty rows.** Every row the sheet has is a line, an empty one too (`{"t","r"}` with no `c`),
  so line order alone places every row and a formula pointing at an empty row still finds it.
  Only the blank grid the editor shows past the last row is not stored: those placeholders
  become rows when someone writes in or below them.
- **Cells.** A value is a JSON string, number, boolean or absent. A formula is `{ f, v }`: the
  formula in A1 notation as the file's order reads it, and its value when the file was saved, so
  nothing that reads the file has to evaluate it. A string that starts with `=` but is text is
  stored as is in a text column; the editor shows it as typed.
- **Why JSON Lines.** It is text, so the reasons docs stay Markdown hold: the bucket is the truth
  and Postgres an index rebuilt from it; text extraction, `drive_fetch`, versions, desktop sync
  and a self-hoster's `cat` read it with no Yjs and no Omni code. One row per line keeps a diff
  between versions readable. CSV was rejected because it holds one tab and no ids, types,
  formulas or views; a Yjs update because only Yjs can read it and the file would stop being
  something the bucket can rebuild from; `.xlsx` because it is a zip the Worker would have to
  unpack for every agent edit and whose cell addresses move on every insert.
- **Search.** A `sheet` reader in `apps/worker/src/storage/extract.ts`, matched by type before
  the `text/` fallback, writes what the `xlsx` reader writes: `--- Sheet: Leads ---` and each row
  as tab-separated displayed values (formula cells by `v`). `drive_search` finds a sheet by what
  is in its cells, and an Omni sheet and an uploaded `.xlsx` read alike.

## The live document

A sheet is live through the same layer as a doc: one S2 stream per file (`docs/<nodeId>`), the
same `seed`, `update`, `fold` and `snap` records, the same realtime socket, `doc.append` checks
and presence. Only the Yjs document inside differs.

```
Y.Doc
  tabs   Y.Map<tabId, Y.Map>     name, p (position), frozen
  cols   Y.Map<colId, Y.Map>     tab, p, width, type, format, options
  rows   Y.Map<rowId, Y.Map>     tab, p, and one key per cell: colId → value
  views  Y.Map<viewId, Y.Map>    tab, name, filter, sort, hidden
```

- **Order by fractional position.** Rows, columns and tabs are ordered by `p`, a fractional
  index string (`fractional-indexing`, CC0), ties broken by id; no `Y.Array`. A `Y.Array` has no
  move, so a sort is a delete and an insert of every row, and two people sorting at once leave
  each row twice.
- **Concurrent inserts.** Two people inserting a row in the same place each make a new row with
  a key between the same neighbours; both rows stay, in the same order on every peer. Every key
  ends in random digits, so two peers almost never make the same one. When they do, the order is
  still by id, but no key fits between two equal keys (`generateKeyBetween` needs `a < b`), so an
  insert into a run of equal keys first gives that run fresh keys between its key and the next
  one, in its current order, in the same transaction. Two peers doing that at once each write
  every key of the run, and last writer wins per row, so each row still appears once.
- **Sorts.** "Sort range" writes new positions for the rows in the range, one key per row. Two
  sorts at once leave each row once, in an order mixed from both; the next sort settles it. A row
  inserted during a sort keeps its key and lands among the sorted rows. Nothing is lost or
  doubled. Filter and sort in a view never touch positions (below).
- **Cells are last writer wins.** A cell is one key of its row's map holding a plain value, not a
  `Y.Text`: two people typing in one cell end with one of the two, as in Google Sheets. Different
  cells in the same row merge.
- **Deletes win.** Deleting a row removes its map; a change made to it at the same time is
  dropped. Deleting a column removes its definition; its cells left in rows are ignored and are
  not written on the next save.
- **Formulas use ids inside.** A formula in the live document references cells by id
  (`=[rc41|c9Pm]*1.16`, `[|c9Pm]` for a whole column, `$` kept per side), so inserts, deletes and
  sorts by anyone never point it at the wrong cell. The file holds A1, translated on seed and on
  save. A reference to a deleted row or column is `#REF!`. A reference past the last row or
  column is held by position (`#N`) and binds to that row or column's id once it exists.
- **Values are computed, not stored live.** Every editor evaluates formulas itself; computed
  values are not in the Yjs document, so a change to one input does not append a change to every
  cell that depends on it. The tab that saves writes `v` into the file.
- **Undo** is each person's own (`Y.UndoManager` with their origin), as in docs.
- **Presence** is the selected cell or range and the name, through `doc.presence`.

**Big records.** A doc's whole state fits one S2 record (`MAX_DOC_MESSAGE`, 900 KB); a sheet's
may not, and neither may one change within the limits (a paste of 40 cells of 32,767 characters,
or an agent's edit of 10,000 cells). Expand the live contract with one record:
`{ t: "more", h, i, u }`, part `i` of the `seed`, `snap` or `update` at sequence number `h`, which
gains `n`, its number of parts; every part fits one socket message. A reader joins the parts and
applies them as one Yjs update only once it holds them all, so a change is never half applied. A
split start missing a part is passed over for the start before it; a split update missing a part
is not applied, and its writer sends the whole change again under a new head (the browser from
its pending queue, the Worker before it folds, failing the agent's edit if it cannot). Docs never write parts, and a reader that predates them
skips the record it cannot parse. A sheet snaps when 200 records have passed since its start
and they weigh more than a quarter of that start, so a large sheet does not rewrite megabytes
every 200 keystrokes.

**Saving** is the doc's: the tab that typed saves 2 s after the typing stops, another tab saves
orphaned changes after 6–10 s of quiet (#705), and saves form editing sessions (#706). The save
serializes the document to JSON Lines with values computed.

## History

Versions and the page history built from the change log are specified once, for docs, and
sheets take them as they are: editing sessions and agent versions from #706, `drive_versions`
from #707, and the history thread in progress. One sheet-specific rule: a sheet's diff compares
cells by row and column id (`Leads!B4 (Acme, Amount): 1200 → 1400`, rows added and removed), not
lines of JSON, so a row inserted above does not show every cell below as changed.

## Formulas

In scope: people expect `=SUM`, and a sheet without formulas is a table.

- **Engine.** Our own parser and dependency graph in `@omni/sheets` (pure, no I/O, no DOM),
  over cell ids, and our own function bodies, about sixty of them (`formula/functions.ts`,
  `text.ts`, `lookup.ts`). `@formulajs/formulajs` was planned for the bodies, but it is 2.4 MB
  unpacked, and its errors and coercions would need wrapping to match ours. The browser and the
  Worker run the same code, so an agent's edit saves the same values the page shows. HyperFormula
  was the alternative: complete and tested, but it owns its own address grid, which would be a
  second model of the sheet to keep in step with the Yjs one, and its size counts against the
  Worker (`modules.md`, risks).
- **Syntax** is Excel's, A1 references, `Tab!A1` and `'My tab'!A1:B9` across tabs of one sheet,
  `B:B` and `2:2`, `$` for absolute.
- **Functions** in v1: arithmetic and comparison; `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`,
  `COUNTA`, `ROUND` and the math family; `IF`, `IFS`, `AND`, `OR`, `NOT`, `IFERROR`; `SUMIF(S)`,
  `COUNTIF(S)`, `AVERAGEIF(S)`; `VLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`; text (`CONCAT`, `LEFT`,
  `RIGHT`, `MID`, `LEN`, `TRIM`, `UPPER`, `LOWER`, `TEXT`, `SUBSTITUTE`, `FIND`); dates (`DATE`,
  `TODAY`, `NOW`, `YEAR`, `MONTH`, `DAY`, `EDATE`, `DATEDIF`, `NETWORKDAYS`). The list lives in
  code; a function not in it is `#NAME?`.
- **Semantics.** Dates are serial numbers in formulas (Excel's 1900 system), so `.xlsx` formulas
  give the same results. `TODAY` and `NOW` are evaluated when shown and saved with the value at
  save. Errors are Excel's (`#REF!`, `#NAME?`, `#VALUE!`, `#DIV/0!`, `#N/A`, `#NUM!` for
  overflow and invalid arithmetic); a cycle is `#REF!`, and a formula nested more than 256 deep
  is `#NAME?`. Formulas read every row, whatever view is open; a range like `A1:A10` keeps its
  size past the stored rows, which read as blank.
- **Out:** array formulas that spill, `QUERY`, `IMPORTRANGE` and references to other files,
  iterative calculation, named ranges.

## Columns

A column has a type; the default is text. Types govern editing and validation, never storage
loss:

| Type     | Holds                               | Options                                   |
| -------- | ----------------------------------- | ----------------------------------------- |
| Text     | Any string                          |                                           |
| Number   | A number                            | Format: plain, percent, currency, decimals |
| Date     | An ISO date (`2026-11-22`)          | With or without time                      |
| Checkbox | `true` / `false`                    |                                           |
| Select   | One of a list of options            | The options                               |

- A value that does not fit its column (text in a number column) is kept as typed and shown as
  not fitting; nothing is thrown away. Changing a column's type converts the values that parse.
- Types apply below the frozen rows, which are the header.
- Numbers are stored as numbers and shown in the viewer's locale.
- Out: multi-select, person, relation, files, and styling per cell (bold, colours, borders,
  merged cells, conditional formatting).

## Views

A view is a named filter, sort and set of hidden columns on one tab, stored in the sheet and
shared by everyone; which view a person has open is theirs (in the URL). Every tab has its plain
grid. A view never reorders rows or changes cells, so filtering does not disturb anyone else's
work; "Sort range" is the action that reorders.

- Filters combine with AND: text contains, is, is empty; number compares; date before, after,
  on; checkbox is; select is any of. Sort is by up to three columns.
- A row added in a view goes after the last row it shows.

**The CRM.** Views overlap the CRM's lists, and that is where it stops. A CRM record has rules a
cell cannot hold (owners, stages, who may delete, a signed contract outliving its deal), and a
sheet is a file anyone with edit access may change. Neither is built on the other. When the CRM
adds saved views (`crm.md`, "Still out"), its filter and sort take this vocabulary; "Export to
sheet" from a CRM list is later work, and it writes a copy, not a live link.

## Import and export

All in the browser, as docs' exports are: SheetJS (`xlsx`, already in `apps/web`) and
`papaparse`. Nothing new runs on the Worker.

- **New sheet** in Drive makes `Untitled`, one tab, 100 placeholder rows and 26 columns shown, none
  stored until written (Empty rows, above).
- **Convert to Omni sheet** from an `.xlsx`: every tab, values, formulas (translated to ours),
  column widths, frozen panes, number formats. Styling, charts, pivots, comments, macros and
  data validation are dropped; a formula using a function we do not have keeps its cached value
  as a plain value. From a `.csv`: one tab, RFC 4180, a first row that looks like a header is
  frozen.
- **Export:** Excel (`.xlsx`, every tab, formulas with cached values, widths, frozen panes,
  formats) and CSV (the open tab, displayed values). **Copy:** the selection as tab-separated
  text, which pastes into other spreadsheets.
- **Paste** of tab-separated text or HTML tables (from Excel, Google Sheets, a web page) fills
  cells from the selection.
- Exports read the sheet as the editor holds it, unsaved typing included, and never create a
  Drive file. The row menu offers Export as Excel and CSV, and no raw Download.

## The editor

Behavior only; the screens follow `DESIGN.md` and the Figma pass (Rodrigo).

- A virtualized grid: only visible cells render, so a sheet at its limits scrolls like a small
  one. Tabs along the sheet. Frozen rows and columns stay in place.
- Select a cell, a range, rows or columns; type to replace, Enter or double click to edit,
  Tab and Enter move, arrows move, Shift extends; copy, cut, paste, delete clears; fill down.
- Row and column menus: insert above, below, left, right; delete; for a column, its type,
  format, options and width. Drag to reorder rows and columns.
- Views from the tab's view menu. One mode in v1, Editing; Commenting comes with cell comments.
- Shared links work as for docs (`docs.md`, "Shared links"): an outside editor saves version by
  version, a viewer gets the read-only grid.

## Agents

Scope `drive:write`, audited as `mcp.drive_sheet`, under the `actions` rate limit, refused in an
unpaid workspace, like the doc tools.

- **Read.** `drive_fetch` on an Omni sheet renders it for an agent from the sheet itself (from
  the live document when it holds unsaved typing, `unsaved_edits: true`, as #707 does for docs):
  each tab as rows of tab-separated values led by the row number and a header line of column
  letters, then its formulas, one line per run of the same relative formula
  (`D2:D120 =B2*1.16`), its column types and its views. It returns `layout`, a token that changes
  whenever rows or columns are inserted, deleted or reordered: a hash of every tab's ordered row
  and column ids, computed from the merged document when it is read. A token stored in the
  document would not work: two concurrent inserts would each write one, only one would win, and
  the other insert could arrive without changing it.
- **Create.** `drive_create_sheet { name, tabs? | csv?, folder_id? | workspace?, space? }`.
  `tabs` is `[{ name, rows: Value[][], frozen_rows?, columns?: [{ type, format?, options? }] }]`;
  a string that starts with `=` is a formula, and `'=` is text that starts with `=`.
- **Edit.** `drive_edit_sheet { id, layout?, edits }`. Each edit names cells in A1 on a `tab`
  (the first tab by default) and applies, in order, to the sheet the edit before it left:

  ```jsonc
  { "set": "B2", "value": 1400 }
  { "set": "A10:C11", "values": [["Beta", 900, "=B10*1.16"], ["Gamma", 400, "=B11*1.16"]] }
  { "clear": "D2:D9" }
  { "append": [["Delta", 700]] }              // answered with the range it landed in
  { "insert_rows": { "before": 5, "count": 2 } }   // also "after"; insert_columns the same
  { "delete_rows": "5:7" }                     // delete_columns "C:D"
  { "column": "C", "type": "select", "options": ["Lead", "Won", "Lost"] }
  { "fill_down": "D2:D40" }                    // copies D2 down, references relative
  { "sort": { "range": "A2:D40", "by": [{ "column": "B", "desc": true }] } }
  { "add_tab": "Q4" }                          // rename_tab, delete_tab, freeze, view
  ```

  All apply or none do. With `layout`, the edit is refused when the layout changed since the
  agent read it, answering the sheet as it is now, so an address never lands on the row someone
  else inserted above it; cell edits by others in between do not refuse it. Without `layout`,
  addresses mean the sheet as it is when the edit runs (fine for a sheet nobody else is editing).
- **Live merge.** As `drive_edit_doc`: when the sheet is open live, the Worker opens its live
  document (`LiveFile`, from the latest start), turns the edits into one Yjs transaction, appends
  it, passes it to everyone editing, evaluates, saves the merged sheet as the next version and
  records the fold. With nobody editing, it builds the document from the file, applies the
  edits and writes the next version checked against the version it read. Each write is a version
  of its own named for the agent (#706). `LiveFile` gains `apply(change)`, under which the doc's
  `rewrite(markdown)` stays.
- **Answer.** The ranges changed, and the changed cells' values after evaluation, so the agent
  sees a formula's result without another `drive_fetch`.
- `drive_versions` on a sheet returns the cell diff (History), not a text diff.

## Limits

Chosen so the whole sheet fits a Yjs document in a browser tab and in a Worker (128 MB) with room
to spare; measured with a seeded sheet before the editor ships, and lowered if they do not hold.

| What                        | Limit                                           |
| --------------------------- | ----------------------------------------------- |
| Cells with a value          | 100,000 per sheet                               |
| Rows                        | 20,000 per tab                                  |
| Columns                     | 200 per tab                                     |
| Tabs                        | 20                                              |
| Formulas                    | 20,000 per sheet                                |
| Text in a cell              | 32,767 characters (Excel's)                     |
| File body                   | 5 MB                                            |
| `drive_edit_sheet`          | 100 edits and 10,000 cells a call               |

| Target (p95)                                          | Budget  |
| ----------------------------------------------------- | ------- |
| Open a sheet at the limits, from its latest snap      | 1.5 s   |
| Recalculate after one cell change, 20,000 formulas    | 50 ms   |
| `drive_edit_sheet` on a live sheet at the limits      | 2 s     |

A file past the limits is refused as a sheet (`too_large`) and stays what it was: an `.xlsx` or
`.csv` too big to convert keeps working as a file, with its text indexed as now.

## Desktop

The File Provider shows an Omni sheet as `<name>.omnisheet`, read-only (the provider marks it so,
as it does a locked file), and opening it opens the sheet in Omni. Editing its JSON from Finder
would bypass validation and formulas. Next, as for docs: Export from the desktop.

## Not in this change

- Charts, pivot tables, conditional formatting, styling per cell, merged cells.
- Comments on cells, and live co-editing for people outside the workspace (as for docs).
- Array formulas, references to other files, named ranges, scripts.
- Keeping an `.xlsx` in sync: conversion is one way, on request.
- CRM-backed sheets, or sheets as CRM storage.

## Plan

Each line is one PR, stacked with `gh stack` on top of #705–#707. No migration in any of them.

| #   | Layer                                                                                                                         | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| SH1 | `@omni/sheets`: type, JSON Lines ↔ Yjs, A1 ↔ ids, positions, formulas, CSV, edits; its unit tests (and its root in `scripts/check-tests.mjs`) | this spec  |
| SH2 | Live layer: `more` records, `LiveFile.apply`, the sheet's snap cadence                                                        | SH1, #705  |
| SH3 | Worker: the `sheet` reader, `drive_create_sheet`, `drive_edit_sheet`, `drive_fetch` and `drive_versions` for sheets; `mcp.md`     | SH2, #707  |
| SH4 | Web: the grid, views, import and export (Rodrigo, from Figma)                                                                 | SH2        |
| SH5 | Desktop: `.omnisheet`, read-only                                                                                              | SH3        |

## Verify

- `packages/sheets` (unit): JSON Lines → Yjs → JSON Lines is lossless, empty interior rows and
  formulas pointing at them included; two peers inserting a row
  at the same place keep both, in the same order, and a row can then be inserted between them
  even when their keys are equal; two concurrent sorts and a sort with an insert
  leave every row exactly once; a change to a deleted row is dropped; a formula keeps pointing at
  its cell after inserts above it and is `#REF!` after its row is deleted; A1 ↔ id translation
  across tabs and `$`; the v1 functions against Excel's results; CSV round trip (quotes,
  newlines, BOM); the limits refuse.
- `apps/worker/e2e/drive-sheets.e2e.test.ts`: an agent's sheet is named without an extension,
  has the sheet type and keeps it after an edit; a range edit with formulas saves computed `v`;
  `drive_fetch` shows values, formula runs and `layout`; `drive_search` finds a cell's value once
  indexed; an edit with a stale `layout` is refused and answers the sheet, including when the change was
  a concurrent insert merged after the agent read; a viewer's agent
  cannot edit; a sheet past the limits is refused.
- `apps/worker/e2e/drive-live.e2e.test.ts`, sheet cases: a tab types into B2 without saving and
  an agent sets C2; the tab hears the agent's change, the saved version holds both, and the
  version is named for the agent. A snap split into parts opens from its parts; a split snap with
  a part missing opens from the start before it; a paste and an agent edit too big for one record
  reach the other tab whole, and a split update missing a part is never applied.
- On the stack: New sheet, type, formulas recalculate; two tabs insert rows at the same place and
  sort at once without losing a row; a view filters for one tab and not the other; Convert an
  `.xlsx` fixture and Export it back, formulas intact; a sheet at the limits opens and
  scrolls within the targets above.

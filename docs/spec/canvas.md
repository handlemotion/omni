# Omni canvases: Drive's own boards

Nov 22, 2026 · Draft for review · Extends `docs/spec/docs.md` and `docs/spec/mcp.md` ("Docs").
Builds on the live layer of #705 (snaps), #706 (versions by editing session) and #707 (agent
version tools).

## Summary

A canvas is an Omni board: an endless surface of shapes, sticky notes, text, connectors, frames,
images and other Drive files, edited live by everyone who has it open and by their agents. It is
the second of Omni's own file types after docs, and follows their pattern: a type of its own, a
name with no extension, an editor of its own, exports to the formats other tools read
(PNG, SVG, PDF), and one live document on the same S2 stream.

Drive is meant to be one place where every kind of file lives together. A canvas helps with that
in two ways. It holds other files (a doc, a sheet's range, a PDF's page) as live tiles. And it is
text underneath, so search, `drive_fetch`, history, desktop sync and self-hosting treat it like
any other Omni file.

## Decisions

| Question         | Decision                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Type             | `text/vnd.omni.canvas` (`CANVAS_TYPE` in `@omni/canvas`), no extension in the name          |
| Stored body      | A JSON scene, one element per line, in paint order; its words extracted for search          |
| Live model       | One Yjs document on the existing `docs/<nodeId>` stream, no new record kinds                |
| Element identity | Random ids made by whoever creates the element; a map from id to element                    |
| Concurrent moves | An element's box is one value: the later write wins it whole, never a mix of two moves      |
| Renderer         | In-house SVG on React, geometry shared with a pure SVG writer; no tldraw, no Excalidraw     |
| Embeds           | A tile that points at a Drive file by id and is drawn through the viewer's own access       |
| Export           | SVG and PNG in the browser; PDF through the print dialog, one page per frame                |
| Agents           | `drive_create_canvas`, `drive_edit_canvas` (element operations), `drive_fetch` (an outline) |
| History          | The same as docs: whatever the doc history thread settles, canvases have it too             |

## The type

- An Omni canvas is a Drive file whose type is `text/vnd.omni.canvas`. The type, not the name,
  makes it a canvas, so its name carries no extension. `isOmniCanvas(type)` answers it.
- Its body is text (`text/`), like a doc's. Every path that reads text keeps working. Any path
  that does not know canvases sees JSON, which still means something: an older Worker indexes
  it as plain text, and a self-hosted install that has not upgraded loses only the canvas's
  editor.
- Drive shows a canvas with its own glyph and the badge `CANVAS`, and New offers Canvas beside
  Doc. Opening one opens the editor as a full page, as a doc does (#704).
- A new version keeps the file's type, through the same `writeText` path that docs use.
- Expand and contract: no migration. A canvas is a node with a type and a body, like any other.

## The stored body

The body is a JSON scene. JSON is easy to read back and to check with zod, it is text, and an
agent or a developer can read it. It is written in a fixed shape:

```text
{
  "omni": "canvas",
  "v": 1,
  "elements": [
    { "id": "f8k2m4q9xa", "kind": "frame", "box": [0, 0, 1600, 900], "text": "Q1 plan" },
    { "id": "s3n7c1p5ve", "kind": "sticky", "parent": "f8k2m4q9xa", "box": [80, 120, 200, 200], "color": "yellow", "text": "Call the roofer" },
    { "id": "s9d2w6h4tb", "kind": "sticky", "parent": "f8k2m4q9xa", "box": [400, 120, 200, 200], "color": "blue", "text": "Order tiles" },
    { "id": "c5j8r3y7ku", "kind": "connector", "from": { "id": "s3n7c1p5ve", "at": [700, 220] }, "to": { "id": "s9d2w6h4tb", "at": [900, 220] }, "route": "elbow", "end": "arrow", "text": "then" },
    { "id": "e2v6b9m1zq", "kind": "file", "box": [1800, 0, 600, 800], "file": "0193f2…", "page": 3 }
  ]
}
```

- **One element per line, in paint order.** The array order is the z-order, parents before
  their children. So a version diff (`drive_versions`) is a list of whole elements added,
  removed or changed, and desktop sync and git show the same. `sceneToJson` writes it the same
  way every time: the keys in a fixed order, numbers rounded to 0.01.
- **Element kinds.** `shape` (rectangle, rounded rectangle, ellipse, diamond, triangle, with a
  label), `sticky`, `text`, `connector`, `frame` (a titled area, with its children), `group`,
  `image` (an image that belongs to the canvas) and `file` (a Drive file as a tile).
- **Geometry.** `box` is `[x, y, w, h]` in board units, `rot` a rotation in degrees. A connector
  has no box: each end is bound to an element (`id`, with the point it was last drawn at in
  `at`) or free (`at` alone).
- **Style by name.** Colours are names from a small palette (`yellow`, `blue`, `green`, `pink`,
  `gray`, …) that the app maps to tokens in light and dark mode. Never hex: a canvas looks right
  in both themes and follows the design system as it changes. Text size is a step (`s`, `m`,
  `l`, `xl`), not a number.
- **Text is plain.** Line breaks, no bold or links in v1. That keeps the scene simple and the
  words easy to search.
- **No names of other files.** A `file` element holds the file's id, never its name or text. A
  canvas is read by people who may not reach the file it shows; its body must not tell them.
- **The words for search.** `canvasText(scene)` gives the words in reading order: each frame's
  title, then its elements top to bottom and left to right, then the elements outside frames.
  The text extractor (`apps/worker/src/storage/extract.ts`) gains a `canvas` reader for the
  type, so `storage_texts` holds the words and no JSON keys, ids or coordinates. Searching
  "roofer" finds the canvas. Searching "box" or "sticky" does not.

## The live document

A canvas is live the way a doc is: one Yjs document kept as the S2 stream `docs/<nodeId>`, with
the same `seed`, `update`, `fold` and `snap` records (`@omni/contracts` `storage-live.ts`), the
same realtime socket, the same saves and the same snaps from #705. Nothing in the stream, the
socket or the Worker's live code needs to know which type it carries, except for one function:
how to turn the Yjs document into the file's text (`liveScene`). `LiveFile` and the web's
`LiveDoc` take it as a parameter, beside the doc's `liveMarkdown`.

### The model

```
Y.Doc
  "canvas"    Y.Map   { v: 1 }
  "elements"  Y.Map   id → Y.Map
                        kind, box, rot, parent, z, color, shape, size, locked,
                        text   Y.Text
                        from, to, route, start, end    (connectors)
                        file, page, sheet, range       (file tiles)
                        node                           (images)
```

- **Ids.** Whoever creates an element names it: 10 random base32 characters (about 50 bits),
  made in the tab or in the Worker for an agent. Two people creating at once can't collide, and
  an element keeps its id for its whole life, so an agent can cite it across calls and a diff
  can follow it.
- **One value per gesture.** `box` is one array value, not four fields. A move or a resize
  writes it whole. If two people move the same sticky at the same time, one of the two moves
  wins it whole for everyone. It never takes the x of one move and the y of the other. Yjs
  settles the order: a write made after seeing the other one wins, and two writes that cross in
  flight are decided by Yjs's fixed rule, the same way on every client. The same applies to
  `rot`, `color`, `from`, `to` and every other field: each field is its own last-writer-wins
  value, so one person recolouring a sticky while another moves it keeps both changes.
- **Text merges by character.** Sticky, text, label and title text is a `Y.Text`, so two
  people typing in one sticky keep each other's words, as in a doc.
- **Z-order.** `z` is a fractional index, a string that sorts between two others
  (`a0` < `a0V` < `a1`), ordered among the children of the same parent, with ties broken by id.
  "Bring to front" writes a key above the highest. Two people doing it at once both land on top,
  in a fixed order. Moving one element never rewrites the others' keys. The JSON body has no
  `z`: its array order is the z-order, and a seed computes fresh keys from it.
- **Frames and groups.** `parent` names the frame or group an element sits in. Children keep
  board coordinates, so a child's box never depends on its parent's. Moving a frame or a group
  writes each child's box in one transaction. Frames sit at the top level only. Groups nest up to
  4 deep, and a group has no box of its own: its bounds are its children's.
- **Drags go through presence.** While someone drags, resizes or rotates, the offset goes out in
  their presence (the awareness update that already carries cursors), so others watch the
  elements move live. The document takes one change at the drop. A drag is then one record and
  one undo step, not sixty records a second, and the snaps every 200 records stay far apart.
- **Delete wins.** Deleting removes the id from `elements`. An edit made at the same time to the
  deleted element is lost with it, and undo brings both back. Deleting an element writes the
  current `at` into every connector end bound to it, so the arrow stays where it was.
- **The read repairs, the document keeps.** `liveScene` reads the document into a valid scene
  every time: an element whose `parent` is gone moves to the top level. When two concurrent
  regroupings form a cycle, the element with the lowest id leaves it. A group with fewer than
  two children dissolves, and a connector end bound to a missing element uses its `at`. The fix
  is written to the file at the next save, and into the live document only with the next change
  made through `rewriteCanvas` (an agent's edit, a restore); nothing rewrites it on its own.
- **Undo is your own.** Each tab's `Y.UndoManager` tracks only its own origin, so undo never
  takes back someone else's work or an agent's.
- **Presence.** Each person's awareness holds their name, colour, cursor in board coordinates,
  viewport and the ids of their selection (up to 50, then only its bounds). That fits the
  existing 4 KB `doc.presence` limit.

### Rewriting from a scene

`rewriteCanvas(doc, scene)` is the canvas's `rewriteLive`: it makes the live document hold a
given scene with the smallest change. Elements missing from the scene are deleted, new ones are
added, and of the rest only the fields that differ are set. Text goes through a character diff
into its `Y.Text`. An agent's whole-scene edit and a restore from history both go through it, so
whoever is editing at that moment keeps everything the change did not touch.

## History

The owner's direction for Omni-editable files is one canonical document with an edit history
drawn from its change log, as in Notion's page history, not a list of file versions. A separate
thread is specifying that history for docs (`docs/spec/docs.md`, "History", once it lands).
Canvases take it unchanged. A canvas's change log is the same stream of records, grouped into
editing sessions as #706 groups saves, with agents' changes standing apart. Restoring goes
through `rewriteCanvas`, so it merges into the live document like any other edit.

Until that lands, a canvas has what a doc has after #706: one version per editing session, one
per agent edit, and `drive_versions` to list and diff them. The one-element-per-line body makes
that diff readable.

## The editor

These are the behaviours. The look comes from the Figma pass (`DESIGN.md`), and the editor shows
no explanatory text.

- **Board.** An endless surface: pan with space-drag, two fingers or the middle button; zoom from
  5% to 800% with pinch, ⌘-scroll or the zoom menu (fit, 100%, selection). It opens where the
  person left it, kept in the browser, or fitted to the content the first time.
- **Tools.** A toolbar floating at the bottom, like the doc's: select, hand, sticky, shape (with
  its kinds), text, connector, frame, image, Drive file, and comment once canvas comments land.
  Single keys select them (`V`, `H`, `S`, `R`, `T`, `C`, `F`).
- **Making things.** Click to place at the default size, or drag to size. A sticky starts typing
  at once. Dragging from a selected element's side handle draws a connector that ends on whatever
  is under the pointer, or makes a copy of the element there when it ends on empty board (the
  quick way to build a flow).
- **Selecting.** Click, shift-click, or drag a marquee. Selection shows handles to resize and
  rotate. A context bar over the selection offers colour, shape, text size, connector route and
  ends, arrange (front, back, align, distribute), group, lock and delete.
- **Snapping.** Edges and centres snap to nearby elements and to the frame. Holding ⌘ disables
  snapping.
- **Keyboard.** Arrows nudge (shift for 10), ⌘D duplicates, ⌘G groups, ⌘⇧G ungroups, ⌘C/⌘V copy
  and paste (between canvases too, as scene JSON, and as text for other apps), Delete removes,
  ⌘Z/⌘⇧Z undo and redo your own changes.
- **Pasting and dropping.** An image file or a pasted image becomes an `image` element. A Drive
  file dragged from the sidebar or picked from the Drive file tool becomes a `file` tile. Pasted
  text becomes a text element, one sticky per line when pasted onto a sticky tool.
- **Modes.** Editing, or Viewing. Viewing allows panning, zooming and following a person; it
  never writes.
- **Follow.** Clicking a person's avatar in the bar follows their viewport until you move.

## Rendering

### What we evaluated

Bundle sizes are measured, not quoted: each library bundled with esbuild (`--minify`, React
external, CSS and fonts excluded), Nov 22, 2026.

| Option                | Licence                                                                                                       | Initial JS, min / gzip | Fit                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tldraw 5.6            | tldraw licence: no production use without a licence key; the free key is non-commercial and shows a watermark | 2.1 MB / 642 KB        | Best editor of the three. But a commercial key is a paid contract, and every self-hosted install would need one of its own, so it fails "self-hostable with no new required service". Its record store is its own and would need its own sync, separate from our S2 stream. |
| Excalidraw 0.18       | MIT                                                                                                           | 1.1 MB / 258 KB        | Free to use, but it is an app, not a library: its own UI, menus, hand-drawn look and scene arrays. Live editing would need a third-party Yjs binding that replaces arrays. Making it look like Omni means fighting it.                                                      |
| In-house SVG on React | Ours (AGPL, as the rest)                                                                                      | about 50 KB gzip, est. | Exactly our model, our look and our stream. We build selection, snapping, connectors and text layout ourselves. That is the cost, and v1's element set is chosen to keep it small.                                                                                          |

Yjs itself (30 KB gzip) is already loaded for docs and counts toward none of them.

### Decision: in-house SVG

- **Why.** tldraw's licence rules it out for a self-hostable product. Excalidraw is free but
  would cost a quarter of a megabyte for a look we would then have to undo, and a second data
  model to keep in step with ours. The boards we need are boxes, text and lines; a renderer for
  those is a modest amount of code, and it is the same code that writes exports and thumbnails.
- **Budget.** The canvas editor is its own lazy chunk: at most 60 KB gzip on top of Yjs, checked
  in CI against the built web app. No runtime dependencies beyond Yjs and `y-protocols`.
- **How it draws.** One `<svg>` for the board, with the viewport as one transform on a group, so
  panning and zooming never re-render React. Elements outside the viewport (plus a margin) are not
  in the DOM. A small grid index answers hit tests and marquee selection. Text edits in an HTML
  overlay bound to the element's `Y.Text`. File tiles are HTML above the SVG, drawn only when on
  screen and larger than a few pixels.
- **One geometry.** `@omni/canvas` holds shape paths, connector routes (straight, elbow,
  curved), arrowheads, snapping and text layout as pure functions. The React renderer and the
  string writer `renderSvg(scene)` both call them, so the editor, an export and a thumbnail draw
  the same board. Text is laid out from a table of the app font's advance widths, kept in the
  package. It needs no DOM measuring, so the Worker wraps the same lines a browser does.
- **Target.** 2,000 elements pan and zoom at 60 frames a second on a 2023 laptop, and a canvas of
  that size opens in under a second from its latest snap.

## Drive files on a canvas

A `file` element shows a Drive file as a tile, live: it draws the file as it is now, not as it
was when placed.

| File      | Tile shows                                                         | Element fields           |
| --------- | ------------------------------------------------------------------ | ------------------------ |
| Doc       | Its title and the start of its page, read-only                     | `file`                   |
| Sheet     | A range of one sheet, as the sheet preview draws it                | `file`, `sheet`, `range` |
| PDF       | One page                                                           | `file`, `page`           |
| Image     | The image (a Drive image, not one belonging to the canvas)         | `file`                   |
| Canvas    | Its thumbnail, one level deep (a canvas inside it is a plain tile) | `file`                   |
| Any other | Its glyph and name                                                 | `file`                   |

- **Drawn through the viewer's access.** A tile is fetched with the person looking at it, through
  the app's doors, never with whoever placed it. Someone who cannot open the file sees an empty
  tile with no name. A link never shows a person something they could not already open.
- **Opening.** Double-clicking a tile opens the file in Drive's preview beside the canvas. Its ⋯
  menu sets the page, sheet or range.
- **Reuse.** Tiles use the previews that exist (`components/storage/preview`: the PDF, sheet and
  doc renderers), loaded only when a tile first needs them.
- **Images belong to the canvas.** A pasted or dropped image is uploaded as an attached file of
  the canvas, as images pasted into a doc are today: whoever may edit the canvas may add one,
  and whoever reaches the canvas reaches its images. The upload rule in `@omni/db`
  (`resolveUploadPlace`) extends from "a doc" to "an Omni doc or canvas". Images draw from their
  Drive thumbnails at the size on screen.
- **A trashed or deleted file** turns its tile empty. The element stays, so restoring the file
  brings the tile back.

## Export

The canvas header shows Export in place of Download, like a doc's:

- **Download:** PNG (at 2×), SVG, PDF (the print dialog, Save as PDF).
- **Copy:** Copy as PNG.
- **What.** The selection when there is one, else a frame when the person picks one in the menu,
  else the whole board. A PDF has one page per frame in frame order, or one page fitted to the
  board when it has no frames.
- **How.** `renderSvg` writes the SVG with the app font embedded and images inlined at the size
  they are drawn. File tiles are inlined as they render for the person exporting, and as empty
  tiles where that person has no access. A PNG is that SVG drawn on an HTML canvas. Everything
  runs in the browser; nothing new runs on the Worker.
- The file's row menu offers Export as PNG and PDF, and no raw Download (the file has no
  extension). Through a shared link, Export shows only when the link allows downloads.

## Thumbnails

A canvas's Drive card shows the board. `GET /files/:id/thumbnail` answers a canvas with
`renderSvg(scene)`: shapes, text and connectors, with images and file tiles as plain frames. It
is cached under the file's content version, like image thumbnails. It is served as
`image/svg+xml` with `Content-Security-Policy: default-src 'none'`, and is made only from
validated scene data with every string escaped. It needs no new binding: the same function that
exports draws it.

## Shared links

A canvas shared through a link opens as the same board, for people outside the workspace too:

| Role      | Board                                                               |
| --------- | ------------------------------------------------------------------- |
| Editor    | Editing, toolbar; saves through the link's door, version by version |
| Commenter | Viewing (canvas comments are not in v1)                             |
| Viewer    | Viewing, no toolbar                                                 |

Outside editors save version by version and don't join the live document, as for docs
(`docs/spec/docs.md`, "Not in this change"). File tiles are drawn with the link's own access,
which reaches only what the link shares, so a link to a canvas never opens the files on it.

## Agents

Scope `drive:write` for the writes, `drive:read` for the read. Neither is destructive: every
change is kept in the canvas's history. The tools follow `drive_create_doc` and `drive_edit_doc`
(`docs/spec/mcp.md`, "Docs"). Agents are poor at raw coordinates, so the operations let them
place things relative to each other and arrange them, and every answer says where things landed.

### Create

`drive_create_canvas { name, ops?, folder_id? | workspace?, space? }` writes a new canvas in the
person's My files (default), a company's Shared, or a folder they can write to, named as given.
`ops` builds its first content with the operations below.

### Edit

`drive_edit_canvas { id, ops? | scene? }`. `ops` are element operations, applied in order. All
apply or none do. `scene` replaces the whole board through `rewriteCanvas`.

| Op                          | Fields                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`                       | `kind`, `ref?`, `text?`, `parent?`, style (`color`, `shape`, `size`), and where: `at {x, y}`, `place {near, side, gap?}` or neither (to the right of everything); `w`, `h` optional; for tiles `file_id` with `page`, `sheet`, `range` |
| `update`                    | `id`, any of `text`, `color`, `shape`, `size`, `locked`, `page`, `sheet`, `range`                                                                                                                                                      |
| `move`                      | `ids`, one of `to {x, y}`, `by {dx, dy}`, `place {near, side, gap?}`, `into` (a frame)                                                                                                                                                 |
| `resize`                    | `id`, `w`, `h`                                                                                                                                                                                                                         |
| `connect`                   | `from`, `to` (element ids or refs), `ref?`, `text?`, `route?`, `start?`, `end?`                                                                                                                                                        |
| `arrange`                   | `ids`, `as` (`row`, `column`, `grid`), `gap?`, `columns?`, `align?`                                                                                                                                                                    |
| `group`, `ungroup`, `frame` | `ids` (and `title` for a frame), `ref?`                                                                                                                                                                                                |
| `order`                     | `ids`, `to` (`front`, `back`, or `{ above: id }`)                                                                                                                                                                                      |
| `delete`                    | `ids`                                                                                                                                                                                                                                  |

- **Refs.** A new element may carry a `ref` the call makes up (`"step1"`). Later ops in the same
  call use it in place of an id, and the answer maps each ref to the id it got.
- **Text updates are diffs.** `update { text }` goes into the element's `Y.Text` as a character
  diff, so a person typing in that sticky keeps their words wherever the change does not touch
  them.
- **Live merge.** As for docs: when people have the canvas open, the Worker opens its live
  document from the latest snap (`LiveFile`, #705), applies the operations as one transaction
  (`applyCanvasOps` in `@omni/canvas`), appends the change and passes it to everyone editing.
  It saves the merged scene as the canvas's next version and records the save in the stream.
  Operations touch only the fields they name: a person dragging other stickies while the agent
  works keeps their drag, and a person moving the very sticky the agent moves wins or loses it
  whole. With no one editing, the change is the file's next version, checked against the version
  it was made on.
- **Validation first.** Every id, ref, file and limit is checked against the board as it is now,
  unsaved changes included, before anything is written. A miss (an id that is gone, a file the
  person can't read) answers with the outline below, so the agent can retry without another
  read.
- **Attributed.** Each write is a version of its own, named for the agent (`writtenByAgent`,
  #706), and is audited as `mcp.drive_canvas`.

### What an agent reads

`drive_fetch` on a canvas returns its outline. Like a doc's text since #707, it is read from the
live document when people are editing (`unsaved_edits: true`):

```
Canvas "Roof repair" · 24 elements · 2 frames · board 0,0 to 3200,900
# frame f8k2m4q9xa "Q1 plan" [0,0 1600×900]
- sticky s3n7c1p5ve yellow [80,120 200×200] "Call the roofer"
- sticky s9d2w6h4tb blue [400,120 200×200] "Order tiles"
- connector c5j8r3y7ku s3n7c1p5ve → s9d2w6h4tb elbow "then"
# outside frames
- file e2v6b9m1zq [1800,0 600×800] → "Roof survey.pdf" page 3 (drive url)
- file k7p3x8n2ra [2500,0 600×400] → no access
```

- Elements are listed in reading order, frames first, with id, kind, colour, box and text. A
  tile names its file and `url` only when the person can open it.
- The answers of `drive_create_canvas` and `drive_edit_canvas` hold the canvas's `url`, the ids
  of new elements by ref, and the lines of the outline for the elements they changed. They also
  list `overlaps`: pairs of elements whose boxes now overlap but did not before, so an agent can
  see that its layout collided without being shown a picture.
- `drive_versions` lists and diffs a canvas's versions as it does a doc's. The diff is in
  elements, one per line.
- `drive_search` finds canvases by their words, like any file.

## Code

| Where                                     | What                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/canvas` (`@omni/canvas`)        | No I/O, no DOM. `CANVAS_TYPE`, `isOmniCanvas`, the scene schema (zod), `sceneToJson`/`sceneFromJson`, `seedCanvas`, `liveScene`, `rewriteCanvas`, `applyCanvasOps`, `canvasText`, `canvasOutline`; with K4, geometry, text layout and `renderSvg` |
| `apps/worker/src/storage/`                | The `canvas` text reader, the canvas thumbnail, `createCanvas` and `editCanvas` beside `createDoc` and `editDoc`; `LiveFile` takes the type's reader                                                                                              |
| `apps/worker/src/mcp/`                    | The two tools; `drive_fetch` reads a canvas's outline                                                                                                                                                                                             |
| `packages/db`                             | Images upload into a canvas as they do into a doc                                                                                                                                                                                                 |
| `apps/web/src/components/storage/canvas/` | The editor (Rodrigo, from Figma)                                                                                                                                                                                                                  |

`@omni/canvas` is pure logic, like `@omni/docs`, and is proven the same way: through the
Worker's e2e tests on the real stack, which run it end to end. It gets no unit tests of its own.

## Limits

| What                 | Limit                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Elements on a canvas | 2,000                                                                                                                |
| Body                 | 400 KB of JSON                                                                                                       |
| Text in one element  | 5,000 characters                                                                                                     |
| Board                | Coordinates within ±1,000,000; sizes from 1 to 100,000                                                               |
| Nesting              | Frames at the top level only; groups up to 4 deep                                                                    |
| File tiles           | 100 on a canvas                                                                                                      |
| Images               | Drive's upload limit each; drawn from thumbnails                                                                     |
| Zoom                 | 5% to 800%                                                                                                           |
| Agents               | 200 operations a call, a `scene` up to 400 KB; the `actions` rate limit; refused in a workspace whose plan is unpaid |

The element and body limits come from the live layer: a live document starts from one record
holding its whole state (a seed, or a snap), and a record must stay under 1 MiB. A canvas's
state is about 1.85 times its JSON body (a 2,000-element board of short stickies: 270 KB of JSON,
500 KB of state), so a 400 KB body leaves room for its history.

A change that would take a canvas past a limit is refused whole, in the editor and for agents
alike. Two people editing at once can still take a board just past the element, tile or body
limit together; it stays readable and editable, and only changes that would grow it further are
refused, so anyone can bring it back under. Agents change boards up to twice the body limit.

## Not in this change

- **Freehand drawing, templates, mind-map layouts, presenting frames as slides, voting and
  timers.** Each is additive on this model.
- **Rich text** (bold, links) in stickies and text. Text stays plain in v1.
- **Canvas comments,** pinned to an element or a point. They need an anchor model that is not
  text, and get their own spec. Until then a Commenter views.
- **A canvas inside a doc,** as a block. The reverse of file tiles, and next once both exist.
- **Live co-editing for people outside the workspace,** as for docs.
- **Desktop sync names** a canvas as Drive does, with no extension, and syncs its JSON body. Next:
  the File Provider shows `<name>.ocv`, as docs will gain `.md`.
- **iOS.** The iOS app shows a canvas's thumbnail and opens nothing more until Rodrigo plans it.
  `@omni/canvas` has no DOM, so an iOS viewer can reuse its geometry.
- **Pinning a tile to a version** of its file. Tiles show the file as it is now.
- **Import** from Miro, FigJam, Excalidraw or tldraw files.

## Plan

One stack, rooted on `main` once #705 to #707 merge. Each layer is one PR, through `gh stack`.

| #   | Layer                                                                                                                                                     | Depends on   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0   | This spec                                                                                                                                                 |              |
| K1  | `@omni/canvas`: type, scene, JSON, the Yjs model, rewrite, ops, text, outline, proven by K2 and K3's e2e                                                  | 0            |
| K2  | Storage: the type in Drive, the text reader, image uploads, link pages                                                                                    | K1, #705–707 |
| K3  | Agents: the live layer taking the type's reader, `drive_create_canvas`, `drive_edit_canvas`, `drive_fetch` outline                                        | K2           |
| K4  | Web: the editor, file tiles, export; geometry, text layout, `renderSvg` and thumbnails, which share the editor's drawing (Rodrigo, from the Figma frames) | K2           |

K3 and K4 are independent of each other. K4 waits for Figma; K1 to K3 do not.

## Open questions

- [ ] Frames inside frames. Left out to keep PDF pages and the outline simple; ask again once
      people use frames.

## Verify

- `apps/worker/e2e/drive-canvas.e2e.test.ts`:
  - An agent's canvas is named without an extension, has the canvas type, and keeps it after an
    edit. Its body parses as a scene, one element per line.
  - After indexing, `drive_search` finds it by a sticky's word and not by `"sticky"`.
    `drive_fetch` returns the outline with ids and boxes.
  - Refs: one call adds two stickies with refs and connects them by ref; the answer maps both.
  - A miss (an id that is not there) changes nothing and answers with the outline.
  - Limits: the 2,001st element and the 201st operation are refused whole. (An unpaid workspace
    is refused by the gate the doc tools share, `ready` in `apps/worker/src/mcp/drive-write.ts`.)
- `apps/worker/e2e/drive-canvas-live.e2e.test.ts`, on the real realtime socket and S2:
  - A tab moves sticky A and types in sticky B without saving. `drive_fetch` shows both with
    `unsaved_edits: true`.
  - The agent then recolours A, appends to B's text and adds a connector. The tab hears the
    records, the file's next version holds the tab's move, both texts and the agent's changes,
    and the version is the agent's.
  - The tab and the agent both move sticky C at once: both settle on one box, whole.
  - The agent replaces the whole board with `scene` while the tab drags sticky D, which the new
    scene leaves as it was. The tab's drag survives, and only the elements that differ changed.
  - Two tabs regroup the same two elements into each other at once. Both tabs and the saved body
    read a valid scene with no cycle, and the same one.
  - Opening from a snap is the same `LiveFile` path for every type, proven for docs in
    `drive-live` (a doc edited past 200 records opens from its snap once the stream before it
    is trimmed); canvases add no code to it.
- `apps/worker/e2e/drive-canvas-access.e2e.test.ts`:
  - Member A places a file from their My files on a Shared canvas. Member B's `drive_fetch` shows
    the tile as `no access`, and neither the outline nor the search text holds the file's name.
  - An image pasted into the canvas is attached to it and opens for whoever opens the canvas.
  - A link viewer reads the canvas and cannot write it, and its file tiles do not open the files.
  - With K4: the thumbnail is `image/svg+xml` with `default-src 'none'`, and a sticky reading
    `<script>alert(1)</script>` comes out escaped.
- On the stack (`pnpm stack:serve`, two browsers as two members): stickies, shapes and connectors
  made in one appear in the other as they are made. A drag shows live and lands as one record.
  Undo takes back only your own change. A PDF tile shows its page for one member and is empty
  for a member without access. Export downloads PNG, SVG and PDF (one page per frame), and the
  SVG opens in another app looking the same. The canvas chunk's gzip size is reported against
  the 60 KB budget.

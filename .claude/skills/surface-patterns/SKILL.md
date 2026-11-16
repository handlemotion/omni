---
name: surface-patterns
description: Omni's recipes for a module's surfaces in apps/web: a list of rows, a grid of cards, a section with its own layout, a sidebar tree, a detail panel beside a list, a page header. Use when building or restyling any of them, or when a screen feels cramped, uneven or busy.
---

# Surface patterns

The recipes the Drive and CRM screens settled on, with their numbers. Read `DESIGN.md` first; it
holds the rules. This file holds what those rules look like built. Depth and press come from
`tactile-design`; measure the result with `design-balance`.

The reference build: `apps/web/src/components/storage/` (`file-sections.tsx`, `file-card.tsx`,
`sidebar-tree.tsx`, `preview/preview-panel.tsx`) and `components/shell/sidebar-tree-row.tsx`.
Copy from there before writing anew.

## Type: two sizes per surface

A surface speaks in **body** (`text-sm`, 13px) and **meta** (`text-xs`, 11px). `text-md` (14px)
is for the one title in a 48px header (page, panel), nothing else. A name in a row, a card or
a tree is body; what it is ("292 KB · PNG", "Folder", a count, a date) is meta in
`text-muted-foreground`, or `text-subtle-foreground` for counts beside a label. Three sizes in
one surface reads busy: drop one. Figures are `tabular-nums`.

## Gaps: the scale in use

| Between                                   | Gap                                        |
| ----------------------------------------- | ------------------------------------------ |
| A page's edge and its content             | 20px (`px-5`; rows `mx-2.5` + `ps-2`)      |
| A glyph or tile and its label             | 12px (`gap-3`) in rows; 10px in sidebars   |
| A name and its meta line under it         | 4px (`gap-y-1`)                            |
| A card's square and its caption           | 8px (`gap-2`)                              |
| Cards                                     | 12px across, 16px down (`gap-x-3 gap-y-4`) |
| A section header's baseline and its items | 8px (`pb-2`)                               |
| Sections                                  | header 48px tall; the first 36px           |

A name sitting on its meta with no gap is the commonest miss: every stacked label pair gets its
4px. Spacing comes from the Tailwind scale; equal padding on opposite sides.

## Rows

Mail's floating row, for any list of records: a React Aria `GridList`, transparent, rows
`mx-2.5 h-12 rounded-lg ps-2 pe-1`, undivided, one spring highlight under them (`RowHover`:
`useFluidHoverList` + `FluidHoverHighlight`). The row leads with its 32px tile (`FileTile`) or
20px avatar, the name takes `flex-1`, secondary columns are fixed widths that leave as the list
narrows (`@max-xl:hidden`, `@max-2xl:hidden` on an `@container`). The row's menu shows on hover,
focus, selection and while open, always on touch (`pointer-coarse:opacity-100`).

The open record is the list's one selected row (`selectionMode="single"`,
`selectionBehavior="replace"`, `selected:bg-accent`): a click or ↑/↓ selects it and the panel
follows. Items that are links (folders) stay out of selection with `disabledKeys` and
`disabledBehavior="selection"`.

## Cards

One card for every kind: a square (`aspect-square rounded-lg border bg-surface shadow-raised`)
holding the thumbnail or the kind's glyph (32px, muted) centred, then the caption: name with the
menu beside it, meta under it. The item itself is the hit area: `rounded-xl p-1.5`, hover
`bg-hover`, open `selected:bg-accent`, press `active:scale-[.99]`. Grid:
`grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]`.

## Sections with their own layout

A page that holds two kinds (folders and files) gives each a section: label, count, then at the
header's far end its layout icons (rows / cards), shown only while that section is hovered or
holds focus. Use `ToggleGroup bare size="sq-xs"`: no track, the chosen icon keeps a faint
border. Each section remembers its own layout per browser, with a sensible default per kind
(containers as cards, records as rows).

## Marks on a fill multiply

An avatar, checkbox or mark that sits on a row that can be hovered, selected or tinted takes
`mix-blend-multiply` (and `bg-accent`/`bg-secondary` for its own fill), so it darkens with the
row instead of punching a white hole in it. Module marks are the exception: a filled Central
glyph (`Icon…Filled`) in white on the module colour.

## Sidebar

Top to bottom: the workspace row (its menu holds the workspaces, then Settings) with the bell
after its chevrons; the module's places; then its trees under `SidebarSection label`; at the
foot, the module row with **Switch**. No call-to-action buttons in a module's sidebar: actions
live in the page header. Trees use `SidebarTreeRow`: 16px per level, the chevron a sibling of
the link (a button can't sit in a link), shown on hover and while open; open state in
`useSidebarExpanded(tree, id)`. A trailing count is meta. Content rows never shrink
(`SidebarContent className="*:shrink-0"`); the sidebar scrolls.

## Page header and detail panel

48px header, no line under it on a list page; the sidebar toggle first, then the title or
breadcrumbs (14px), then the actions as labels alone (`Button size="sm"`, no icons; outline for
secondary, primary for the one main action). A detail panel beside a list keeps its own line
(`border-b`, `border-s`), a `ResizeGrip` on its edge with `useStoredWidth`, the list never under
320px, and full screen hiding the list (`useFullScreen`). Its state is in the URL (`?file=`), so
Back and Esc close it.

## Layout traps

- A virtualizer or an `auto-fill` grid inside a flex parent needs `min-w-0` and `w-full`, or its
  first layout sets the page's width (everything in one row, or one column).
- A drop zone or any centring flex box around page content: make it `block` and let it scroll,
  or content that measures short floats mid-page.
- `content-visibility: auto` skips paint, not mounting: gate fetches (thumbnails) on an
  `IntersectionObserver`, never on render.
- A menu inside a selectable row stops `pointerdown`/`pointerup`/`click`/`keydown` from
  bubbling (`KEEP_IN_MENU`), or choosing an item also selects the row.

## Prove it populated

Screenshots of an empty account hide every one of these. Seed the stack with real records
(folders inside folders, every file kind, a dozen images, a few hundred rows) through the app's
own API and upload flow, then capture at 1440×900 @2x, hover and open states included, and look
at each before calling it done.

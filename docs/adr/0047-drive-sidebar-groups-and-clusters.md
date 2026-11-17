# 0047: Drive's sidebar in Team and Personal groups, with clusters

Date: 2026-11-16 · Status: accepted · Amends: ADR 0034 decision 8 (Storage's web UI)

## Context

Drive's sidebar listed the places (My files, Shared, Shared with me, Trash), then each space's
folders as a tree of any depth, files included. Moving between the team's folders and your own
meant reading two similar trees, and there was no way to find a file by name.

## Decision 1: main links, then two groups

Top to bottom: Upload, Search, Shared with me, Trash; then, under a Folders section label (mail's),
a **Team** group (a company's
Shared; a Personal space has none) and a **Personal** group (My files). The spaces are named Team
and Personal everywhere the app shows them (sidebar, breadcrumbs, the Move dialog). A group's row
links to its space and starts open; the chevron closes it.

Upload, an action in a sidebar of places, is there because it was asked for: it uploads into the
folder on screen, or Personal's top anywhere else.

## Decision 2: clusters are top-level folders

A space's top-level folders are its **clusters**: under a group, each cluster opens to the folders
inside it, and the sidebar tree stops there. Deeper folders and all files are on the folder pages.
There is no cluster object in the schema: a cluster is a folder, so it moves, shares and trashes
like one, and a real cluster type can still come later without migrating data.

A cluster can take a glyph in place of the folder, picked from a fixed set
(`STORAGE_FOLDER_ICONS`) with **Change icon** in a top-level folder's menu. It lives in its own
table, `storage_folder_icons` (one row per folder that has a glyph), not in a column on
`storage_nodes`: every node query selects and inserts all of that table's columns, so a column
would break all of Drive whenever the Worker deployed before its migration ran (nothing waits for
migrations, ADR 0019). The sidebar reads glyphs with `GET /icons?space=`, and before the table
exists that request fails alone and clusters show the folder. A member sets one with
`PATCH /nodes/:id { icon }` (null clears it); a grantee cannot. Setting it is neither an edit nor
a sync change: "Modified" and the revision stay.
Nested folders always show the folder; a glyph a client doesn't know shows the folder too.

## Decision 3: Search across both drives

`GET /api/storage/search?q=` (live files and folders whose name holds `q`, ignoring case) reads
the member's My files and, in a company, Shared, through the member door (`findOperations`). It
does not page: it answers at most 50, shown in the folder page's sections. A node in Trash, or inside a folder that is, is left out.

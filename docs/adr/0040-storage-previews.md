# 0040: File previews in Storage

Date: 2026-11-16 · Status: accepted · Amends: ADR 0034 (decision 5, "Not in v1: Previews")

## Context

ADR 0034 shipped Storage as download only: every file leaves the Worker as
`application/octet-stream`, `content-disposition: attachment`, `nosniff`, and "nothing a person
uploaded ever renders on our origin". Previews were listed under "Not in v1".

Opening a file to see what it is now belongs in the app, beside the folder, as an open thread
sits beside the inbox. The founder asked for it on 2026-11-16, with the Drive list and grid
views.

The risk ADR 0034 guarded against is unchanged: a file a stranger uploaded (an HTML page, an SVG,
a PDF with script) must never run as a document on the app's origin, where it would hold the
reader's session.

## Decision

Previews render in the client, from the same download route, without changing what the Worker
serves. No uploaded file is ever navigated to, framed, or turned into a document on our origin.
Each kind goes through a renderer that cannot execute it:

| Kind                                            | How it renders                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raster images (PNG, JPEG, GIF, WebP, AVIF, BMP) | Fetched, re-wrapped as a `Blob` of an allow-listed raster type, shown in `<img>`. A raster image cannot run script, even opened in its own tab. Over 40 MB: no preview.     |
| Video and audio                                 | `<video>` / `<audio>` on the download URL with `preload="metadata"`, streamed by `Range`. Media elements decode, they never parse markup.                                   |
| PDF                                             | pdf.js (`react-pdf`) on the download URL, drawn to `<canvas>` with range requests, `isEvalSupported: false`, no annotation layer: the PDF's own script and forms never run. |
| Text and code                                   | The first 512 KB by `Range`, decoded as UTF-8, rendered as React text nodes (Shiki tokens for highlighting, no HTML injection). HTML, SVG and XML show as source.           |
| CSV and TSV                                     | The first 512 KB, parsed by Papa Parse, shown as a table of text cells.                                                                                                     |
| Anything else                                   | The file's type and Download.                                                                                                                                               |

SVG is shown as source, never as an image: an SVG `blob:` URL opened in its own tab would be a
document on our origin.

Thumbnails in the grid use the image path above, downscaled once in the browser to the tile's
size and cached for the session, so a folder of photos fetches each original once, at most four at
a time. The download route stays `no-store`.

Previews go through both doors: the member's (`/api/storage/files/:id/content`) and a shared
link's, so a link reader sees the same panel.

## Consequences

- The Worker and its headers are unchanged; a self-hoster needs nothing new.
- Previews cost the reader's bandwidth: an image is downloaded whole (capped), a PDF or video only
  the ranges it shows.
- Office formats (DOCX, XLSX, PPTX) get no preview. Rendering them would need a converter on the
  server or a heavy client parser; it is its own decision.
- Folder tiles show no item count: the list API returns none. Adding one is an additive field on
  `GET /nodes`, when a design needs it.

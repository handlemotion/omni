# 0053: Storage thumbnails, zip downloads and conditional downloads

Date: 2026-11-20 · Status: accepted · Amends: ADR 0034 (decision 5, how a file leaves), ADR 0040
(thumbnails in the grid, `no-store`)

## Context

The Drive gap audit (workstream W2) found three server gaps behind slow and failing clients:

- Grids on web and iOS draw thumbnails by downloading originals of up to 20 MB each, `no-store`,
  so every visit downloads them again (ADR 0040).
- There is no way to download a folder or a selection: people download files one by one.
- Every file leaves as `application/octet-stream`, which may stop Safari playing video, and the
  route answers no conditional request, so nothing can be revalidated.

## Decision

1. **Thumbnails are drawn by the Cloudflare Images binding (`IMAGES`) and kept in R2.**
   `GET /files/:id/thumbnail?size=256|640|1280` (and the same under `/shared/:shareId`) answers
   a WebP no larger than `size` on its longest edge, for JPEG, PNG, GIF, WebP, AVIF and HEIC up
   to 20 MB, Images' input limit. It is drawn once, on first request, and stored at
   `<object key>.thumbnail-<size>.webp` in `STORAGE_BUCKET`. A new version is a new object, so it
   gets new thumbnails; `deleteStorageObjects` deletes a file's thumbnails with it, and the
   workspace sweep takes them with the workspace's prefix. They are not counted in usage.
   - Images rather than a WebAssembly library: decoding a 20 MB photo needs more memory than a
     Worker isolate has (128 MB), and Images does it outside the isolate. The binding is part of
     every Cloudflare account and `wrangler dev` resizes locally (with sharp), so a self-hoster
     needs nothing new. Each file and size is one unique transformation, billed once.
   - R2 rather than the Cache API: the Cache API does nothing on `workers.dev`, where a
     self-hoster may run, and is per data centre; R2 serves every request after the first.
   - SVG is not drawn (it is markup a stranger wrote, ADR 0040). Anything else, or a file Images
     cannot read, is `415 no_thumbnail`, and the client shows the file's icon.
   - PDFs get no server thumbnail yet: Images does not read PDFs, and rendering one in a Worker
     needs a browser. Clients keep drawing the first page with pdf.js. Video frames could come
     from the Media binding later; that is its own decision.
   - A thumbnail is our own re-encoded raster, so it is served `inline`. With `v` equal to the
     file's `contentVersion` it is `private, max-age=31536000, immutable`; without it,
     `private, no-cache` with an ETag.
2. **A zip is streamed, stored (not compressed), with its length known up front.**
   `GET /zip?ids=` or `POST /zip` (form or JSON `ids`), and `GET /shared/:shareId/zip` (the
   whole share by default), zip the selected files and folders with everything live inside them.
   - The entries come from one recursive query per selected item, through the same door as a
     download (`archive` in `@omni/db`), so a link or a grant zips only what it can open. Trash
     is left out. Two selected items with one name become `name (2)`.
   - Entries are stored, not deflated: what people keep in a drive is mostly compressed already,
     and the Worker's CPU then goes to the CRC alone, computed by `node:zlib`'s native `crc32`
     (about nine times faster than a JavaScript table in workerd). Sizes are known before the
     first byte, so the response has an exact `content-length` (a `FixedLengthStream`) and the
     browser shows progress; each CRC follows its file in a data descriptor.
   - ZIP64 records are written only where a size or an offset passes 4 GiB.
   - Memory holds one chunk and the central directory: objects are read one at a time and only
     as fast as the client takes them.
   - At most 5,000 entries (`STORAGE_ZIP_MAX_ENTRIES`), since each file is one R2 read and a
     Worker on the Paid plan makes 10,000 subrequests per request; more is `413 zip_too_large`.
   - A missing object mid-stream ends the download short: the client sees a failed download,
     never a wrong file.
3. **Downloads are conditional and may be kept.** The download route passes `If-None-Match`,
   `If-Modified-Since`, `If-Match` and `If-Unmodified-Since` to R2 and answers `304` or `412`,
   sends `Last-Modified`, and checks `If-Range` in the same read as the range (one R2 call, not a
   `head` and a `get`). It is `private, no-cache` instead of `no-store`: a browser may keep a
   copy but revalidates before using it.
4. **Audio and video leave as their own type.** A fixed list of audio and video types (MP4,
   QuickTime, WebM, Ogg, MPEG, AAC, FLAC, WAV) is served as itself, still as an attachment with
   `nosniff`, so `<video>` and `<audio>` play it in Safari. A media element decodes and never
   parses markup, and every other type, HTML and SVG included, is still
   `application/octet-stream`.

## Consequences

- Clients (W5 web, W7 iOS) should use the thumbnail route for grids and pass `v`, and use
  `/zip` for folder and multi-select downloads; a web download can be a plain link or a form post,
  so the browser streams it to disk.
- Link sharing's "disable download" (W3) must refuse `/shared/:shareId/zip` as it refuses
  `/content`; until then a zip is allowed wherever a download is. A thumbnail is a preview, not
  the file, so whether view-only links show one is W3's call.
- A self-hoster on the Workers Free plan has 1,000 subrequests to Cloudflare services per
  request, so a zip there holds a little under 1,000 files.

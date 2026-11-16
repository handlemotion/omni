# 0041: Remote images load by default

Date: 2026-11-16 · Status: accepted · Amends: spec v1, "Rendering rules" (remote images)

## Context

The spec blocked remote images by default to stop tracking pixels, with a "Load images" item in
the message's ⋯ menu. In use, nearly every newsletter and product email is unreadable without its
images, so the reader chose "Load images" on almost every message. The founder asked on
2026-11-16 for images to load without that step.

Every remote image already goes through the Worker's image proxy (`/api/image-proxy`), so the
sender never sees the reader's IP address, browser, or cookies. What blocking still prevented is
the sender learning that, and roughly when, a message was opened.

## Decision

1. The web app loads a message's remote images, through the image proxy, as soon as its full
   HTML shows. The ⋯ menu no longer offers "Load images".
2. The mail service keeps storing HTML with remote images blocked (`data-omni-src`); the client
   swaps them in. Stored mail does not change, any client that does not swap still renders it
   safely, and a later per-reader "block remote images" setting needs no re-sync.
3. Open tracking is accepted: a sender's pixel can tell it a message was opened, through the
   proxy, but not who or where from. This is what Gmail and Apple Mail (with privacy protection)
   do.

## Consequences

- Newsletters read as sent, without an extra click.
- Senders using tracking pixels see opens. If that matters later, a per-reader setting can turn
  blocking back on without touching the stored HTML.

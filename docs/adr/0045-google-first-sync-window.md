# 0045: A Google account indexes recent mail only

Date: 2026-11-16 · Status: accepted · Amends: ADR 0023 (All Mail follows in the background), ADR 0013

## Context

ADR 0023 has a Google account sync INBOX first and then everything else, All Mail included, in
the background. In production on 2026-11-16 a newly connected account had indexed about 120 INBOX
messages after two hours and was still `pending`: the app showed "Starting to sync", no other
folder had synced, and outbox actions waited. A Gmail account holds years of mail and Omni is
ready only when the first INBOX sync finishes, so the size of the account decided how long a
person waited. Rodrigo: "just the last week or so would've sufficed".

Why each message took about a minute is a separate question (the speed of the import). This ADR
is about how much is imported.

## Decision

Applies to mailboxes with provider `gmail`. Every other mailbox indexes everything, as before.

1. **The window.** A Google account indexes mail from `GMAIL_SYNC_DAYS` (default 7) before the
   mailbox was connected (`mailboxes.created_at`), and everything after. The start is fixed: the
   window grows with new mail and never slides forward, so indexed mail does not age out.
2. **Per folder, by UID.** On each sync that lists a folder, the mail service asks the server for
   the messages dated on or after the start (`SEARCH SINCE`). The lowest UID among them is the
   folder's floor (the folder's `UIDNEXT` when there are none). The index holds every message at
   or above the floor, plus whatever is already stored. Mail below the floor is never listed.
3. **Nothing is stored for the window.** The floor is read from the server every time, from a date
   that comes from the mailbox row. A wiped index rebuilds the same set (ADR 0013 still holds),
   and there is no schema change.
4. **Older mail stays in Gmail.** There is no background backfill and no fetch on demand. Raising
   `GMAIL_SYNC_DAYS` brings the older mail in on the next sync; `0` indexes the whole account.
   Search and scrolling back reach only what is indexed.
5. **Mail that enters a folder later is indexed whatever its date.** A message moved back into
   INBOX gets a new UID above the floor, so an old conversation someone un-archives in Gmail
   shows up.
6. **Resume.** Unchanged, and now proven for a windowed import: a sync imports the wanted UIDs
   that are not stored yet, newest first, so a restart or a dropped connection fetches only what
   is missing.

## Why not the alternatives

- **Background backfill of everything.** It is what ran in production. It holds the connection
  and a concurrency permit for hours, and most of what it imports is never opened.
- **On demand (search or scroll fetches older mail).** The right next step if people miss old
  mail, but it needs a search path to Gmail and API and UI work. Not needed to make connecting
  fast.
- **A stored floor per folder.** A new column that a rebuild would have to recompute anyway.

## Consequences

- A Google account is ready after one week of INBOX instead of all of it, and the ADR 0044
  catch-up on connect (mail already read in Gmail becomes Done) runs as soon as that is in.
- A reply to a conversation older than the window shows as a thread with only the new messages.
  The rest is in Gmail.
- A windowed folder is listed on every sync (two small searches), because the server's message
  count no longer equals the stored count, which is how a sync knew nothing was appended or
  expunged. Flags are read only from the lowest stored UID up.
- An old message moved into INBOX after connect is indexed there, but its All Mail copy is below
  All Mail's floor. Archived again, it has no indexed copy left and leaves Omni (ADR 0013's
  "gone everywhere"), though Gmail still has it. It is outside the window again.
- Mail that was already indexed is kept: an account that synced everything before this shipped
  keeps it, and an account caught mid-import keeps what it has and stops going further back.
- Deleting inside the window still converges: only mail the index holds can look deleted.
- GreenMail is not Gmail. `apps/mail/e2e/sync-window.e2e.test.ts` proves the window, the resume,
  the rebuild and that nothing outside the window is pruned; `service.e2e.test.ts` proves the
  setting applies to Google accounts only. Gmail's own `SEARCH SINCE` and All Mail are checked
  only against a real account (`google-live.e2e.test.ts`, on request).

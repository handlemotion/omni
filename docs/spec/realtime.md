# Realtime: a reconnect catches up instead of refetching

Nov 22, 2026 · Draft · Extends `docs/spec/v1.md` (Realtime) and `docs/spec/talk.md` (Realtime)

## Summary

The per-workspace realtime Durable Object (`Realtime`, one per org) numbers what it tells
members and keeps the last hour of it. An app whose socket dropped sends how far it had heard
when it reconnects, and the object sends the events it missed, in order, before anything new.
The app knows nothing was lost and skips its refetch. Before, a dropped socket could not tell
what went by, so every reconnect refetched mail, CRM and Drive, and every deploy (which closes
every socket at once) made every open app refetch at once.

S2 stays where it is, behind live documents (`docs/spec/live-sharing.md`). The object already
sees every event, in order, so it keeps the log in its own SQLite storage: no extra hop out of
Cloudflare per event, and no new service.

## What is logged

Every event the object sends to members, but presence:

| Events                                                                    | Heard by                       |
| ------------------------------------------------------------------------- | ------------------------------ |
| Mail and helpdesk (`changed`, `merged`, `thread.changed`, `note.created`, `action.*`, `sla.*`), notifications, `domain`, `crm.changed`, `calendar.changed` | The members it was sent to (watch sockets: `WATCHED` ones) |
| `storage.changed`                                                         | As `driveAudience`: a teamspace's members, everyone for Shared, the owner's app and sync sockets for My files |
| `talk.message`, `talk.changed`                                            | The two members' `team` sockets |
| `talk.online`                                                             | Every `team` socket             |

Not logged, because they describe now and not what happened: conversation presence,
`file.presence`, `doc.presence`. Not logged, because they have their own catch-up: a live
document's records (S2's `seqNum`), `doc.comments` and `doc.access` (an open doc rereads its
comments whenever its socket opens).

Each logged event goes out with `seq`, the log's number for it, the same for every recipient.
Recipients are kept as tags of who should hear it, decided when it is sent, so a member who has
no socket open at that moment still finds it in the log.

## Protocol

- Every socket's first message is `{ type: "sync", epoch, seq, resumed }`: the log's identity,
  its last number, and whether everything before this message is what the socket missed.
- An app that heard a `sync` reconnects with `?since=<epoch>.<seq>`, the highest it has heard.
  The object sends that socket's events after it, then `sync` with `resumed: true`.
- It answers `resumed: false`, replaying nothing, when it cannot vouch for the gap: another
  epoch (the object's storage was reset), a cursor ahead of the log, a gap older than the hour
  or the last 20,000 events (both pruned), or more than 500 of the socket's own events. The app
  then refetches, as before.
- `@omni/client` says `open` once `sync` arrives, with `resumed` beside `reconnected`, after
  handing `onEvent` what was replayed. If no `sync` comes within 3s (a Worker without the log),
  it says `open` without one. Older apps ignore `sync` and `seq`.

The cursor is only a starting point: what a socket hears is still decided by the tags the Worker
gives it from the session, so a forged `since` reaches nothing it would not have heard live.

## Defaults chosen here

- One hour, at most 20,000 events, pruned every 256 appends and before each replay.
- At most 500 of a socket's events replayed; past that a refetch is cheaper.
- The web app skips its mail, CRM and Drive refetch on a resumed reconnect; Talk still refetches
  on every open, since a fetch started before the socket may land after it, and so does the
  teamspace list, whose changes send no event to replay.
- iOS keeps refetching on every return to the foreground (it opens a new socket, so it has no
  cursor yet).

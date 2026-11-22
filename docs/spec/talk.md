# Talk: who is here, and a quick line to them

Nov 22, 2026 · Draft · Extends `docs/spec/modules.md` ("What is shared") and `docs/spec/v1.md`
(Drive)

## Summary

The title bar shows the teammates who have Omni open right now, as a small stack of their
pictures. Clicking one opens a compact conversation with them that floats over whatever module
you are in: quick notes, and above all files dropped straight to that person. It is light
communication between teammates, not a chat product: no channels, no groups, no calls.

Talk is not a module a person picks on the rail. In the code it is one, with the module layout
and rules (`docs/spec/modules.md`), because it owns tables and reads Storage through its door.

## What a person sees

- **The stack.** In the title bar, left of the notifications bell, in every module: the
  workspace's teammates, online or not, at most 3 pictures overlapping, then a fourth circle
  reading `+n` for the rest. Yourself never. A teammate with unread notes for you shows first,
  then those online, then by name. An offline teammate's picture is dimmed and greyed; you can
  still open their thread and write, and they read it when they are back (or get a push). When
  the workspace has no other teammate, there is no stack.
- **Everyone.** `+n` turns the same window into the people chooser, like a face does its
  thread: resting on it peeks, moving there from a face slides the window under it, a press pins
  it. It lists online teammates first, then the others, each with their unread count. Any of them
  opens their conversation in place; an offline teammate reads it next time.
- **The window.** A small white island just under the face it belongs to (or `+n`), its top
  right corner under the face, kept on screen, 288px wide. It behaves like a tooltip: resting on
  a face a beat (200ms) peeks at that thread; moving to another face slides the same window to it and
  swaps the thread in place; leaving both closes it. A press on a face, or a touch inside the
  window, pins it open until it is closed. Only a pinned window takes the keyboard.
  - One fixed height, empty or full, so moving between faces never resizes it.
  - A one-line header: their name and a green dot while they are online; close shows on hover.
  - The notes as bubbles: yours on the right in primary, theirs on the left in secondary. A time
    line wherever an hour passes. An image is a rounded picture in its own proportions (at most 176 by 256px); any other file a chip with its
    glyph, name and `PNG • 5 KB`. Reactions are white chips overlapping the bubble's lower edge, wrapping when there are many, in
    the platform's emoji (Apple's first); four quick ones float above a bubble on hover.
  - The composer inside the island at its foot: `Note to <first name>…`, attach (+) and a round
    send button with an up arrow. Dropping files on the island sends them. The first note to
    someone makes the thread, so you can type and send at once.
  - No expanded mode: it stays small. One window is open at a time; opening another teammate
    replaces it.
- **Unread and notifying.** A teammate's picture carries a dot while you have unread notes from
  them. A note that arrives while no Talk window is open floats in as a bare blue bubble with its
  text under the sender's face (or `+n`), its tail pointing at them, for 5 seconds (resting on it
  keeps it); pressing it opens the thread. A note that arrives while its window is not open (or
  Omni is in the background) also shows a
  system notification, when desktop notifications are on for this device, and opens the window
  when clicked. Opening the window reads the conversation.

## Who may use it

- **Teammates only.** Members of a workspace who are not freelancers. A freelancer is
  in a workspace to work on their projects: they neither see who is online nor get threads.
  A Personal space has Talk once someone joins it.
- **One thread per pair.** A thread belongs to exactly two members of one workspace. Only those
  two read it, write to it or react in it; nobody else, an owner or admin included, can open it,
  learn it exists or see its unread count. No admin view.
- **Leaving.** A member removed from the workspace takes their threads with them (the rows
  cascade). The files they sent are in their My files, and are handed over with the rest of it
  (`handOverMemberStorage`).

## Model

All tables carry `org_id`, cascade with the workspace, and are named `talk_*`.

- `talk_threads`: `id`, `org_id`, `member_a_id`, `member_b_id` (the two members' ids in sorted
  order, `a < b`, so a pair has exactly one row: unique on `(org_id, member_a_id, member_b_id)`),
  `created_at`, `last_message_at`. Both members cascade.
- `talk_messages`: `id` (uuidv7, so ids sort by time), `org_id`, `thread_id`, `author_member_id`,
  `body` (text, at most 4,000 characters) and/or a file: `file_node_id` (Storage node, set null
  when the node is deleted for good), `file_name`, `file_size`, `file_mime`. At least one of body
  and file. `reactions_version` (goes up with each change to its reactions). `created_at`.
- `talk_reactions`: (`message_id`, `member_id`, `emoji`), `org_id`, `created_at`. An emoji is
  one grapheme of at most 16 bytes; a person has at most 8 different ones on a note.
- `talk_reads`: (`thread_id`, `member_id`), `org_id`, `read_at`. Unread is the other person's
  notes after `read_at`.

Reads and writes go through `forMember(db, memberId).talk`, which loads the member, refuses a
freelancer, and reaches only threads the member is one of the two in. The
door takes the other person as a member id and checks they are a teammate in the same workspace.

## Files go into Drive

A dropped file is uploaded by the Worker into the **sender's My files, in a folder named
`Talk`** (made on first use), and the Worker adds a **viewer grant for the recipient's address**
on that file. The message keeps the node's id and, as what the sender sent, its name, size and
type.

Why Drive and not attachments of its own:

- **One store.** Bytes, quotas, billing, the per-file limit, previews and thumbnails, versions,
  Trash and the sweep already exist for Storage. A second store would need all of them again.
- **The grant is the access.** The recipient opens the file through Storage's grant door, the
  same way as any file shared with them; Drive's sharing panel shows it is shared and with whom,
  and the sender can revoke it there. Talk never decides who reads bytes.
- **It is a real file.** The sender finds what they sent in My files / Talk; the recipient can
  save it to their own drive or share it on. Nothing is copied to "keep" it.
- **Why My files, not a teamspace.** A file sent to one person is that person's to see. A
  teamspace per pair would put every pair in the sidebar; My files is private already and the
  grant reaches the one person it is for.

The name, size and type are kept on the message because Talk reads no Storage table: the
message says what was sent. When the file is gone (trashed, deleted, grant removed), the card
still says what it was and opening it answers not found, as any revoked share does.

Opening a file is `GET /api/talk/messages/:id/file`: Talk checks the note is in one of your
threads, then Storage's own doors decide. The sender is sent to the file's content through the
member door, the recipient through the share link their grant opens (read fresh each time, since
a link can be reset).

The folder drops go into is shared with nobody else: if the sender shares their `Talk` folder in
Drive, the next drop makes a new one, so a later file is never visible to that folder's
grantees. Each drop also tells the sender's open Drive listings that the folder changed.

Upload is one request: `POST /api/talk/threads/:id/files?name=…` with the bytes as the body and
its `content-length`, up to `STORAGE_MAX_FILE_BYTES` and the workspace's storage limit, like
saving a mail attachment to Drive. A failed grant or message aborts the upload, so no orphan
file is left.

## API

Under `/api/talk`, member sessions only, behind the plan's read-only gate like every write.

| Route                                   | What                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `GET /people`                           | Teammates with picture, online now, their thread id and unread count    |
| `POST /threads` `{ memberId }`          | The thread with that teammate, made on first use (idempotent)           |
| `GET /threads/:id/messages?before=`     | Newest notes first, 50 a page (`limit` up to 100), with reactions       |
| `POST /threads/:id/messages` `{ body }` | A note                                                                  |
| `POST /threads/:id/files?name=`         | A file, as above                                                        |
| `PUT /threads/:id/read`                 | Reads it up to now                                                      |
| `PUT /messages/:id/reactions/:emoji`    | Adds a reaction (idempotent); `DELETE` removes it                       |

A thread the member is not one of the two in answers `404`, never `403`, so its existence does
not leak.

## Realtime

Online is the existing per-workspace realtime Durable Object, not a new service. An app that
shows Talk opens its socket with `?talk=1` (the web app only while its title bar, and so the
stack, is on screen: a narrow window that hides it is not a way to reach you, so push still does); the Worker then tags it `team` when the member is a
teammate (never on a sync or watch socket, never for a freelancer). Only those sockets count and
hear Talk, so a client that has no Talk (iOS today, an older web build, the desktop's watch
sockets) never shows its member as online, never swallows a push, and gets no event it does not
know. Then:

- `talk.online` `{ memberId, online }`: sent to the workspace's `team` sockets when a member's
  first `team` socket opens and when their last one closes. `GET /people` reads the same set
  from the object, so a fresh app starts right and events keep it right. A dropped socket goes
  offline when the object sees it close.
- `talk.message` `{ threadId, messageId, fromMemberId, preview, message }`: to both members'
  `team` sockets (the sender's other devices too). `preview` is the first 120 characters of the
  note, or the file's name; `message` is the note as `GET …/messages` answers it. A recipient
  with no `team` socket open gets an Expo push when push is on. The Worker sends it after
  answering the sender, so a send never waits on the realtime object.
- `talk.changed` `{ threadId, reactions?, read? }`: a reaction changed, to both members, with
  `reactions: { messageId, reactions, version }` as the note now has them. A note's
  `reactionsVersion` (also on every note a page returns) goes up with each change to its reactions,
  under one lock per note, so a client keeps the highest and skips an older snapshot; a read, to the reader's own
  devices only, with `read: true` and `readAt`, how far it read.

A client applies what an event carries to the thread it has loaded: a note goes on top (once,
by id), reactions replace the note's, a read clears that thread's unread count (or refetches the counts when a note went by after
`readAt`), notes take their place by id so out-of-order events still show in order, a note from the
other one adds to it. It never refetches a whole thread for one note. An event that carries
nothing (an older Worker) makes it refetch what the event names, the thread's newest page for a
note. A reconnect is sent the Talk events it missed (`docs/spec/realtime.md`) and still refetches Talk, so a missed event is caught up either way. Every write is a row with its
own id, so a retried request at most adds a note again; reactions and reads are upserts.

## Speed

- **Sending** shows the note at once, before the server answers; the stored note takes its
  place, and a failed one is taken away and its text goes back to the composer.
- **Opening** a window shows its thread from memory when loaded in the last minutes. Resting on
  a face starts loading it before the peek opens, and threads with unread notes load in idle
  time, so a note that arrived while the window was closed is there when it opens. A closed
  window keeps only the thread's newest page, so opening it again draws one page.
- **Scrolling back** loads the next, larger page (100 notes) once `Earlier` comes within a
  screen of view, before the reader reaches it.

## Deferred

- **Calls and video.** The composer leaves room; nothing is built. Calls need a media service,
  which a self-hosted install does not have.
- **Voice notes and screen recording.** A recording is a file, so they will arrive as files.
- **Groups.** Threads are pairs. A group would be a thread with a member table; nothing here
  prevents it.
- **Typing, seen and editing or deleting a note.** Not in v1.
- **iOS and the desktop's watch sockets.** The phone gets a push and nothing else; the desktop app
  hears Talk only through its open window, not through the sockets it keeps for other
  workspaces.
- **Agents.** No MCP tools for Talk.

## Defaults chosen here

- The stack shows every teammate, offline ones dimmed, at most 3, then `+n`; unread ones first,
  then online ones, then by name.
- An hour between notes starts a new time line in the window.
- Notes are plain text, 4,000 characters at most; links are not previewed.
- Files land in `My files / Talk`; the recipient's grant is `viewer`.

## Plan

One stack, on top of Drive's (#755), since Talk adds a migration and changes the realtime object
that stack also changes.

| #   | Layer                                                              |
| --- | ------------------------------------------------------------------ |
| T0  | This document                                                      |
| T1  | `@omni/db`: schema, migration, the member door; leak tests         |
| T2  | Worker: `/api/talk`, files through Drive, online and delivery; e2e |
| T3  | Web: the stack in the title bar and the floating window            |

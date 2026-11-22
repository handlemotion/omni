# Live co-editing through shared links

Nov 22, 2026 · Draft for review · Extends `docs/spec/docs.md` ("The live document", "Shared
links") · Builds on the live-layer stack (#705 snaps and orphan saves, #706 versions by session,
#707 agents read the live text)

## Summary

People outside the workspace who open a doc through its link, with the Editor or Commenter role,
join the live document as members do. They see the typing, the cursors and the comments as they
happen, and their own typing reaches everyone else within a batch. This replaces today's
fallback, where an outside editor saves version by version and members editing live reopen on
each save.

Outsiders come in two kinds, and the spec treats them differently wherever it matters:

| Outsider  | Who                                                                      | Door                     |
| --------- | ------------------------------------------------------------------------ | ------------------------ |
| Grantee   | Signed in, with a grant to one of their addresses (`storage_grants`)      | `grantDoor(userId, scope, shareId)` |
| Guest     | Anyone holding a link open to anyone, not signed in or not granted       | `linkDoor(shareId, visitor)`        |

Everything here is the Storage module plus the shared realtime object. Nothing touches mail.

## What changes

| Before                                                        | Now                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A link alone is always Viewer (`linkDoor`)                    | A link has a role: Viewer (default), Commenter or Editor, for docs                         |
| Outside editors (grantees) save version by version            | Outside editors and commenters join the live document over a socket opened through the link |
| Only members open the realtime socket (`/api/realtime`)       | `GET /api/storage/shared/:shareId/realtime?node=<id>` opens one for an outsider, on one doc |
| Every socket in the org's object hears Shared-drive events    | Outsider sockets hear only their one doc's records, presence and comments                 |
| A doc's records carry no author                               | The realtime object stamps each record with who sent it (`by`)                            |
| A version names the member who saved it                       | It also names a guest who wrote it, and everyone whose typing it holds (`coauthors`)      |
| A commenter's comment reaches others through an awareness ping | The Worker tells everyone on the doc (`doc.comments`); the ping stays for older tabs      |

## Decisions

### 1. Outsiders join the org's realtime object, pinned to one doc by a tag

**Decision.** An outsider's socket lands on the same `Realtime` Durable Object as the doc's
members: `idFromName(node.orgId)`, one per org, as today. It is tagged `out:<nodeId>` as its
first tag (the tag every handler reads) and `guest:<guestId>` or `user:<userId>` as its second.
The socket edits that one doc for its whole life. To edit another doc in a shared folder, the
page opens another socket.

**Why not one object per doc for outsiders.** Members' records, folds, agents' records
(`docRecords`, `passOnRecords`) and the orphan save already meet in the org's object. A second
object would need every record forwarded across objects in both directions, a hop on every
keystroke batch, and two places that decide who hears what. One object keeps one ordering and
one place to check.

**What it costs, and the guard.** The org's object also serves the workspace's inbox. A flood of
anonymous traffic must not slow it down, so every outsider limit (decision 5) is checked in
memory before any I/O, and a refused message costs a counter and a `JSON.parse`. If outsider load
measurably delays the inbox's events, outsiders move to a per-doc object behind the same socket
messages: the contract below names no object, so clients don't change.

**Hibernation tags.** Tags are set once, at `acceptWebSocket`, and survive hibernation; so does
the attachment. `getWebSockets("out:<nodeId>")` finds exactly the outsiders on one doc, which is
how records, presence and rechecks reach them without walking every socket. The attachment holds
what the recheck needs (decision 2): the door kind, `shareId`, `userId` and scope for a grantee,
the link key for a password-protected link, the role, `checkedAt`, and the guest's identity.

**Insiders and outsiders never share a listing.** Today `storageChanged` (for Shared),
`audience()` and the thread-presence loop call `ctx.getWebSockets()` with no tag and would hand
an outsider Shared-drive listings, `file.presence` member ids and conversation presence. Every
such call goes through one helper, `insiders(ctx, tag?)`, which drops `out:` sockets, and a
policy script (`scripts/check-realtime-audience.mjs`, run by `pnpm check`) fails on a bare
`getWebSockets()` in `apps/worker/src/realtime*.ts` outside that helper. An outsider socket is
reached only through `getWebSockets("out:<nodeId>")`.

**What an outsider socket may send.** `doc.append` and `doc.presence` for its own `nodeId`, and
`ping`. Anything else (`presence`, `file.presence`, another `nodeId`) is dropped without an
answer. Its `file.presence` is implied: it edits its doc from the moment it opens.

### 2. Opening the socket through the link's door

`GET /api/storage/shared/:shareId/realtime?node=<nodeId>`, a websocket upgrade, runs the link's
existing `open` middleware first, so the `storageLink` rate limit, the link's state (expiry,
policy, `workspace` links, password) and the door choice are the ones every `/shared` request
already gets. Then:

1. **The door.** `openShared` tries the member door, then the grant door, then the link door, as
   today. A member gets `409 use_member_socket`: their page joins through `/api/realtime?org=` as
   any member does, so a member is never an outsider. A grantee gets their grant's role; a guest
   gets the link's role (`link_role`, below).
2. **The doc.** `node` must be a doc (`isDocFile`) the door reaches (`shared.file(node)`), not in
   Trash and not locked. A Viewer is refused (`403`): viewers read the saved text, as today.
3. **The origin.** The same `allowedOrigins` check as `/api/realtime`, against cross-site socket
   hijacking: the link key and guest key are cookies the browser sends on its own.
4. **Credentials.** A browser cannot set headers on a websocket, so a password-protected link
   is unlocked by its `omni_link_key` cookie, whose path (`/api/storage/shared/<shareId>`)
   already covers `/realtime`. The iOS app sends `x-omni-link-key`. Never a query string.
5. **Who it is.** A grantee is their user (`user:<userId>`). A guest gets a guest key, signed with
   the auth secret by `@omni/crypto` (`signGuestKey`, next to `signLinkKey`): a random 128-bit
   guest id with an expiry, in an `omni_guest` cookie on the same per-link path, kept 30 days.
   The same browser is the same guest on that link across reloads, and a guest on two links is
   two guests: nothing follows a visitor from one workspace's link to another's. The key is given
   by `GET /shared/:shareId` when it opens a file the link's role lets them comment on or edit;
   the socket refuses a guest without one (`403`).
6. **Into the object.** The Worker strips every `x-omni-*` header the client sent, then sets
   `x-omni-outside` to the JSON the object needs (door, ids, role, identity, the link key) and
   forwards to `REALTIME.get(idFromName(node.orgId))`. The object trusts that header because
   only the Worker can reach it, as it trusts `x-omni-member-id` today.

### 3. The role is checked on every append and presence, and a revocation cuts in seconds

**On each message.** `doc.append` keeps its `RECHECK_MS` (2 s) rule: if the socket's check is
older, the object checks again before appending. For an outsider, "checks again" is
`checkOutside`: the door rebuilt from the attachment and asked for the file. For a grantee,
`forUser(db, userId, scopeOrgId).storage.under(shareId).file(nodeId)`. For a guest,
`publicStorage(db, shareId, visitor).file(nodeId)`, where the visitor's `unlocked` verifies the
stored link key with `linkKeyMatches`, so a new password ends a session that knew the old one.
`doc.presence` from an outsider gets the same 2 s check, since a commenter has no appends to
trigger one.

**Without a message.** An outsider who only listens still hears the text, so their access has to
end without them sending anything:

- **At once, on a change.** Every route that can narrow access tells the org's object to recheck
  its outsiders (`recheckOutsiders(nodeIds | "all")`), after the response, as `announceDrives`
  does: link access or role changed, link reset, password set or changed, expiry changed, grant
  removed or downgraded, sharing policy changed, a node moved, trashed or made team-only, a file
  locked. A move or a policy change rechecks every outsider in the org; there are at most 200
  (decision 5), each one indexed query.
- **On a timer, as a backstop.** While any outsider is connected, the object's alarm sweeps them
  every `OUTSIDE_RECHECK_MS` (10 s), and also fires at the earliest time-bound end it knows: the
  link's `expiresAt`, the link key's expiry. A recheck call lost in a deploy or a failed
  `waitUntil` costs 10 s, not the session.

**What the socket hears.** Lost access entirely (or now a Viewer): `doc.access { role: null }`,
then the object closes it with `4403`. A downgrade from Editor to Commenter: `doc.access { role:
"commenter" }`, the socket stays, and its appends are refused `read_only`. An upgrade is heard the
same way. The page follows `doc.access`; a socket closed with `4403` does not reconnect.

**Billing.** A workspace's plan never makes it read-only (`docs/spec/billing.md`): a workspace
whose plan ends is on Free, and outsiders keep editing as before.

### 4. Who outsiders are to others, and what they see of members

**The server says who is typing.** `doc.presence` carries a Yjs awareness update, opaque today.
For a doc with outsiders on it, the object decodes it (the awareness encoding is a count and,
per client, a client id, a clock and a JSON state: a pure codec in `@omni/docs`, no I/O) and:

- **binds client ids to the socket, across the doc.** Client ids are not secret: every awareness
  update carries them. So the object records, on every doc and for members' sockets too, the
  client id each socket first speaks for (in its attachment, which survives hibernation). A
  socket's first id is bound to it only if no other socket on the doc, member or outsider, holds
  it; otherwise the update is dropped and the socket binds nothing. After that, an update for any
  id but the socket's own is dropped. An outsider cannot move or remove anyone's cursor, from this
  socket or a second one.
- **stamps `user`.** For an outsider's state, `user` is replaced with the identity the server
  gave it: `{ name, slot, kind }`. A client cannot name itself.
- **keeps only what a cursor needs.** A state passed on keeps `user`, `cursor` and `comments`
  and drops everything else.

**A guest's name and colour.** The server picks them from the guest id: `Guest <Animal>` from a
fixed list of 24, and a colour slot 1–6 (`slot`, the same six `--collaborator-N` tokens members
get). Guests do not type a name in this version: a typed name could read as a member's, and an
anonymous name field is a place to post abuse to everyone on the doc. The client renders `kind:
"guest"` as a guest; how is a Figma decision for the web owner.

**A grantee's name.** Their account name, or their address's local part, and a slot from their
user id; `kind: "grantee"`. Members also see the grantee's address, as the Share dialog already
shows it to them.

**What outsiders see of members: their name and colour on this doc, nothing else.** A member's
state reaches an outsider as `{ user: { name, slot, kind: "member" }, cursor, comments }`: no
picture, no address, no member id. An outsider never hears `file.presence` (it carries member
ids) or anything about another file. They see members only while both are on the same doc, which
the member chose to share. Comments already show their author's name to anyone who reads them.

**What members see of outsiders.** Their cursor and stamped identity, through awareness. They are
not added to `file.presence` in this version (the event's `memberId` is required, and a guest has
none); the doc's facepile reads awareness.

Member-to-member presence is unchanged: a doc with no outsider on it is passed on as it is.

### 5. Abuse limits on outsiders

Each check runs in the object's memory, in this order, before any I/O. A refused append answers
`doc.refused` with `rate`; a socket refused 50 times in a minute is closed with `4429`.

| Limit                         | Value                                       | Where                         |
| ----------------------------- | ------------------------------------------- | ----------------------------- |
| Socket opens                  | `RATE_LIMIT_STORAGE_LINK_LIVE`, `30/60`     | Worker, per IP or user        |
| Sockets per guest or grantee  | 5                                           | Object, by the second tag     |
| Outsider sockets per doc      | 50                                          | Object, `out:<nodeId>`        |
| Outsider sockets per org      | 200                                         | Object                        |
| `doc.append` per socket       | 30/s, bursts of 60                          | Object, token bucket          |
| `doc.presence` per socket     | 10/s                                        | Object, token bucket          |
| One outsider record           | 900 KB, as a member's (a paste fits)        | Object                        |
| Outsider bytes per doc        | 20 MB an hour                               | Object storage, by the hour   |

The record kinds are a limit too: an outsider appends `update` records to the current epoch and
nothing else. A `seed` or `snap` is a whole state that every reader starts from, and a `fold`
claims the text is saved, so a forged one could replace the document or stop it saving. Every
`seed`, `snap` and `fold` on a doc is written by a member's tab or the Worker. When an outsider
opens a doc with no current epoch, `GET /shared/:shareId/files/:id/live?from=latest` seeds one
from the file on the server first. When outsiders' records cross `STORAGE_LIVE_SNAP_EVERY` and
no member tab snaps, the fold (decision 7) writes the snap.

Token buckets live in memory and reset when the object hibernates. That is fine: a socket that
is sending keeps the object awake. An outsider's bytes per hour sit in storage, since that limit
is what keeps the stream's size bounded.

Links: a link's Editor role is only for docs. Through a link, a guest still uploads nothing,
creates nothing, renames nothing: the link door's HTTP writer stays `null`. What a guest changes
reaches the file only through the fold. The `linkDoor` comment ("an anonymous editor would be
an open upload endpoint") stays true.

### 6. A Commenter's comments flow live without append rights

A commenter's socket joins like an editor's, but its `doc.append` is always refused `read_only`.
It hears every `doc.record`, so it reads the text as it is typed. It sends `doc.presence`, so
others see where it is reading and what it selected.

A comment is not a record: it lives in `storage_comments`, anchored by its text (quote, prefix,
suffix), and goes through `POST /shared/:shareId/files/:id/comments`. After a comment is added,
edited, resolved or deleted, through any door, the Worker calls the object's
`commentsChanged(nodeId)`, which sends `doc.comments { nodeId }` to every member and outsider
socket on the doc. Pages refetch the comments when they hear it. The awareness `comments` ping
(`useLiveComments`) keeps working for tabs from before the deploy and is removed in the contract
step.

Guests comment too, which they cannot do today (the link door has no writer).
`storage_comments.author_guest` (`{ id, name }`, nullable) is the author when there is no member.
`mine` compares the guest id, so a guest edits and deletes only their own comments, and anyone
who may comment resolves. Guest comments count against a new rule,
`RATE_LIMIT_STORAGE_LINK_COMMENT` (`30/600`, per link and IP, since a new guest key is free to
get), and do not notify anyone by mail or
push; members see them in the doc.

### 7. Saves by outsiders, and how versions and the edit history name them

**Outsiders' tabs never save.** That ends the version-by-version path for docs. Their typing is
saved by the Worker's **fold**:

- After an outsider's accepted append, the object notes the doc as owed a fold and sets its alarm
  for `FOLD_MS` (2 s) after the latest one, the same pause a member's tab waits, but never later
  than `FOLD_MAX_MS` (10 s) after the first append the doc was owed for. Outsiders who type
  without a pause still reach the file every 10 s, and the server's snaps are not put off either.
- The alarm runs `foldLive(env, orgId, nodeId)` for each doc owed one. It awaits R2, S2 and
  Postgres, and a Durable Object takes other messages while it awaits, so the inbox's events are
  not held up; its CPU is one merge and one Markdown serialization. No queue: an alarm that throws
  is retried by the runtime with backoff, and the doc stays owed until a fold succeeds.
- The fold opens `LiveFile` from the latest start (#705), and if it holds records no fold covers,
  writes the merged Markdown as the next content with `base` set to the fold's `cv`, appends the
  `fold`, and passes the records on through `docRecords`, as an agent's edit does.
- **It is idempotent.** Run twice, the second run finds nothing unsaved and stops. A
  `version_conflict` (a member's tab saved first) re-reads and tries again, three times at most;
  a member's own save then covers the same records anyway. The orphan save of #705 still runs in
  members' tabs, and the race between them is the one #705 already settles with `savedAs`.

**Records say who sent them.** The object stamps every record it appends with `by`, overwriting
whatever the client sent: `m:<memberId>`, `u:<userId>` for a grantee, `g:<guestId>` for a guest.
The Worker's own records (agent edits, the fold) carry the agent or nothing. Records sent to
an outsider, on the socket or from `/shared/.../live`, have `by` removed, since it holds member
ids.

**Versions.** A save, by anyone, now records who it holds:

- **The writer.** Who saved, as today: a member, or a grantee's member row (a grantee writes as
  a member of another workspace or their Personal space, the way their comments already do, via
  `grantDoor.actor`). For the fold: the author of the latest record in the range, and for a
  guest, `written_by_guest` (`{ id, name }`) with no member.
- **The coauthors.** The outsiders whose records the save holds, as `coauthors`:
  `[{ kind: "guest" | "grantee", id, name }]` (a guest id or a grantee's user id). Members are not
  listed: their own saves name them. The realtime object knows who appended since the last save,
  so the fold names them, and when a member's tab saves (its `fold` record), the object adds the
  outsiders that save holds to the file's content (`addCoauthors`).
- **Sessions (#706).** A session is one writer: a member id, or a guest id. A fold's save
  continues a session when its writer is the session's. Superseded autosaves merge their
  coauthors into the version that is kept, so the one entry Versions shows names everyone who
  wrote in that stretch.

**The edit history.** The sharing audit trail (`storage_share_events`) gains the kind `edited`:
one row when an outsider's first record of a session is accepted (`via` `grant` or `link`,
`actor_user_id` for a grantee, `detail.guest` for a guest), so the owner sees who edited through
the link and when, next to `viewed` and `downloaded`.

**Agents.** `drive_fetch` (#707) keeps saved text for files it reaches through a share link. That
stays right: an agent acting for a grantee reads through the grant door, and the saved text now
trails the live one by 2 s after a pause, 10 s at most.

## Contracts and routes

Expand, then contract, as `AGENTS.md` requires: migrations, the Worker and clients deploy in any
order, and the Worker serves the web build, so a tab open across the deploy runs old code.

### Expand (the implementation's PRs)

**`@omni/db`** (one migration, numbered above #706's `0066`):

- `storage_nodes.link_role` and `storage_upload_links.link_role`: the grants' enum
  `storage_grant_role` (`viewer`, `commenter`, `editor`), not null, default `viewer`. `linkDoor`
  returns it as the role, marked `viaLink` so `editsContent` stays false; `inside`, `change`,
  `remove` and `share` stay false. Existing links stay Viewer. Editor means editing a doc's live
  document: through a link, nothing else is written over HTTP.
- `storage_policies.link_editing`, boolean, default true (a workspace that never set a policy
  allows everything, as today): when false, links open no wider than Commenter.
- `storage_contents.written_by_guest`, `storage_versions.written_by_guest`,
  `storage_contents.coauthors` and `storage_versions.coauthors` (jsonb, nullable; null for
  versions from before).
- `storage_comments.author_guest` (jsonb, nullable).
- `storage_share_event_kind` gains `edited`.
- Every table is already workspace-owned with `org_id`; none is new.

**`@omni/contracts`:**

- `storageLinkRoleSchema`; `StorageLink.role`; link settings take `role`.
- `storageLiveRecordSchema`: `update` gains optional `by`. Old readers parse records with it,
  since `z.object` drops keys it does not know.
- `storageDocEventSchema`: refusal reasons gain `read_only` and `rate`; new events
  `doc.access { nodeId, role: "editor" | "commenter" | null }` and `doc.comments { nodeId }`. Old
  tabs fail to parse the new events and ignore them, which is what `realtime.ts` clients already
  do with an event they don't know.
- Awareness `user` is documented as `{ name, slot, kind, image? }`. `slot` and `kind` are new and
  optional; old member tabs read `name` and `color` and draw a guest's caret without a colour
  until they reload.
- Versions: `writtenByGuest`, `coauthors`. Comments: `authorGuest` (boolean, optional).
- `StorageSharedResponse` gains `live: boolean`: whether this page may open the socket (the role
  allows it, the doc is not locked, the live layer is on).

**Worker routes:**

| Route                                                   | Change                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/storage/shared/:shareId/realtime?node=`       | New: the outsider socket (decision 2)                        |
| `GET /api/storage/shared/:shareId/files/:id/live?from=` | New mount of `storageLive` on the shared door; `by` stripped; seeds when no epoch is current |
| `POST/PATCH/DELETE /api/storage/shared/:shareId/files/:id/comments` | Open to guests whose link is Commenter or Editor  |
| `PUT /api/storage/nodes/:id/sharing/link`, `/uploads/:id/sharing/link` | Take `role`; refused `policy` when `link_editing` is off and the role is Editor |
| Every route that narrows access                         | Calls `recheckOutsiders` after the response                  |
| Every comment route                                     | Calls `commentsChanged` after the response                   |

**The realtime object:** `insiders()`; outsider tags and attachment; `checkOutside`; the
outsider branch of `doc.append` and `doc.presence`; awareness stamping; `by` stamping;
`recheckOutsiders`, `commentsChanged`; the alarm (rechecks, expiries, folds owed).

**Config:** `RATE_LIMIT_STORAGE_LINK_LIVE` and `RATE_LIMIT_STORAGE_LINK_COMMENT`, zod-validated in
`env.ts`, in `apps/worker/.dev.vars.example` and `docs/self-hosting.md`. No new binding: the
fold runs in the realtime object's alarm, through the Storage module's `foldLive` hook
(`apps/worker/src/modules.ts`), since platform code reaches a module's Worker folder only
through the registrar.

**Self-hosting without the live layer.** When S2 is not configured, `live` is false and docs save
with checked saves alone, as today. Then a link's Editor role saves nothing for a guest (there is
no fold to save it), so the Share dialog offers links no wider than Commenter, and grantees
keep saving version by version.

### Contract (a later PR, once production runs the expand)

- Remove the awareness `comments` ping, once no tab from before `doc.comments` is open (a week
  after the deploy, since tabs reload on deploy).
- Remove grantees' version-by-version save path for docs while `live` is on: the web page stops
  using it in the expand; the Worker refuses it after. Non-doc files keep their uploads.

## Boundaries

- Only Storage and the shared realtime object change. `apps/mail`, mail tables and the
  Purelymail API are untouched.
- Every read goes through a door (`forMember`, `forUser`, `publicStorage`); routes query no mail
  tables.
- The fold and `recheckOutsiders` are idempotent: run twice, they save nothing twice and
  close nothing twice.
- The awareness codec and the guest-name picker are pure (`@omni/docs`), the guest key is
  `@omni/crypto`'s, and no second signer is written.
- No Handlemotion-specific value: limits and keys are environment variables with defaults.
- `apps/web` and `apps/ios` are owned by the web and iOS owner. The client side (opening the
  outsider socket in `live-doc.ts`, following `doc.access` and `doc.comments`, drawing guest
  carets) is specified here; its UI waits for its Figma frames and the owner's go-ahead.

## Stacking

The implementation is a stack on top of #707, each layer a `gh stack` layer:

1. **db + contracts:** the migration, `linkDoor` roles, the schemas. Nothing uses them yet.
2. **Worker:** the outsider socket, rechecks, stamping, limits, the fold, comments for
   guests, the policy script.
3. **Web:** the client side, when the web owner asks for it.

## Not in this change

- Viewers on the live document. A viewer reads the saved text, at most 10 s behind.
- Guests choosing their own name.
- Outsiders in `file.presence` (members see them through awareness).
- Mail or push notifications for guests' comments.
- A doc opened inside a shared folder joins live only once the folder page passes the doc's
  `live` along; the web app does this for a doc opened directly by its link. Inside a folder, a
  grantee still saves version by version, and a guest Editor reads only.

## Verify

E2e against the local stack (`pnpm stack:up`, s2-lite), no mocks. Each names the bug it catches.

**`apps/worker/e2e/drive-live-shared.e2e.test.ts`** (new)

- A guest on an Editor link opens the socket, types, and a member's socket on the doc hears the
  record; the member's typing reaches the guest. *(Outsiders do not join at all.)*
- A grantee with an Editor grant does the same, signed in, through the grant door. A member who
  opens the link gets `409 use_member_socket`. *(A member would be treated as an outsider.)*
- A Viewer link, a link to a non-doc file, a locked doc and a doc in Trash refuse the upgrade.
- An Editor link turned into a Commenter link: within 2 s the guest hears `doc.access
  { role: "commenter" }` and its next append is refused `read_only`, and nothing reaches the
  stream. *(A downgrade still appends.)*
- The link set to restricted, reset, expired, given a new password, or the doc moved out of the
  shared folder: the guest's socket, sending nothing, closes with `4403` within 10 s, and in
  under a second when the change came through a route. *(A listener keeps hearing the text.)*
- A grant removed: the grantee's socket closes; another grantee on the same doc keeps editing.
- **Leaks.** A guest on doc A while members type in doc B, upload into Shared, open a
  conversation and move files: the guest's socket hears only records, presence and comments of
  A, and no message it receives contains a member id, an address or a picture URL. A guest
  sending `doc.append`, `doc.presence` or `file.presence` for doc B gets nothing and B's stream
  is unchanged. `GET /shared/:shareId/files/B/live` for a doc outside the link is `404`.
- **Spoofing.** A guest's awareness update naming itself after a member arrives at the member's
  socket stamped `Guest <Animal>`, `kind: "guest"`; an update for another socket's client id is
  dropped. A guest's second socket whose first update claims a member's client id, or the guest's
  own first socket's, binds nothing, and the member's cursor stays where it was.
- A guest's `seed`, `snap` or `fold` is refused `read_only`; a 70 KB paste is taken whole; 100
  appends in one second are cut to the bucket and the socket closes after sustained refusals.
- A guest types and leaves; with no member on the doc, the file's content holds their text
  within a few seconds, its version has `written_by_guest` set, the stream has the fold, and a
  second fold writes nothing. *(Guests' typing is never saved, or saved twice.)*
- A guest types without a pause for 30 s; the file's content changes at least every 10 s.
  *(Continuous typing postpones the only save.)*
- A member and a guest type together; the member's save lists the guest in `coauthors`.
- A guest comments through a Commenter link; a member's socket hears `doc.comments` and the
  comment lists the guest as author; the guest cannot delete a member's comment.
- An outsider's appended record, read back from the stream, has `by` set by the server, whatever
  the client sent; read through `/shared/.../live`, it has none.

**`packages/db/e2e/storage-sharing.e2e.test.ts`**

- `link_role` defaults to Viewer, existing links stay Viewer, and `link_editing` off refuses an
  Editor link.
- The link door with role Editor still has no writer: no upload, folder, rename or move.

**`packages/db/e2e/storage-versions.e2e.test.ts`**

- A guest's two quick fold saves are one session; another guest's save ends it; superseded
  autosaves' coauthors survive on the version that is kept.

**Unit:** `packages/crypto` (a guest key matches, expires, and fails on another link or secret);
`scripts/check-realtime-audience.test.mjs` (a bare `getWebSockets()` fails the check).

**On the stack:** two browsers, a member signed in and a guest in a private window on an Editor
link, typing into the same paragraph: both see each other's text and carets; the link set to
Viewer closes the guest's page to read only within seconds.

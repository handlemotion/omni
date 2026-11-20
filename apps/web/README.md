# @omni/web

The web app: a Vite + React single-page app on TanStack Router and TanStack Query. The Worker
serves the built files and `/api` on one origin, so the session cookie is first-party and there
is no CORS.

## Run it

```bash
pnpm stack:up
pnpm --filter @omni/worker dev --var BETTER_AUTH_URL:http://localhost:5173
pnpm --filter @omni/web dev          # http://localhost:5173, forwards /api to :8787
```

`BETTER_AUTH_URL` points at Vite so magic links land on the hot-reloading app. Without Doppler,
the Worker reads `apps/worker/.dev.vars` instead. `OMNI_API_ORIGIN` (see `.env.example`) points
the dev proxy somewhere else. `pnpm build` writes `dist/`; `wrangler dev` and `wrangler deploy`
build it themselves.

`pnpm test:e2e` (stack up, `DATABASE_URL` set) drives the app in Chromium against the Worker under
`wrangler dev` and the mail service: reconnecting after a Worker restart, and replies written
offline. It uses Playwright's Chromium when installed (`PLAYWRIGHT_BROWSERS_PATH`), else the
machine's Chrome.

`pnpm bench` (stack up, `perf:seed` run, `DATABASE_URL` set) measures startup, switching lists,
opening a thread, loading older mail and scrolling in that Chromium against the 200k-message seed,
with the CPU slowed 4x (`scripts/bench.ts`). Run it before and after a performance change.
`BENCH_LATENCY=80` adds a round trip to every request; `BENCH_H2=1` serves the app over HTTP/2 as
production does (`wrangler dev` alone is HTTP/1.1, which queues the scripts six at a time).
`pnpm bench:drive` does the same for Drive (`scripts/bench-drive.ts`): startup on My files,
switching places, opening a folder, loading 3,000 files of a 5,000-file folder, scrolling them,
and selecting one, against the seed's Drive (`perf:seed` makes it too).

## Layout

```
src/
  main.tsx           query client + router
  router.ts          router options (preload on intent) and its typed context
  routes/            the path map; each route = guard + loader + placeholder component
  lib/               data layer: no React components, no styling
  hooks/             what components call
  components/        UI (Rodrigo's): ui/ primitives, icons/, one folder per feature
  styles.css         design tokens (see DESIGN.md)
```

Components use `hooks/` only. `lib/` is how the hooks work.

## Path map

Every page inside a workspace starts with its slug (`$ws` below); mail has its own
`/mail` prefix. A path from before (`/inbox/<id>`, `/files/my`, `/settings`) is sent on under the
session's workspace.

| Path                                               | Search params                        | Loader                                           |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------ |
| `/`                                                |                                      | redirect to the workspace's `/$ws/mail/inbox`    |
| `/login`                                           | `redirect?`, `error?`                | signed-in members are sent on to `redirect`      |
| `/invite/$invitationId`                            |                                      | the invitation (any signed-in user)              |
| `/onboarding`                                      |                                      | setup status (may create, or finishing one)      |
| `/$ws/mail/inbox`, `/$ws/mail/inbox/$threadId`     | `mailbox?`, `lane?`, `view?`, `tag?` | first page of the list; the thread               |
| `/$ws/mail/later`, `/$ws/mail/later/$id`           | `mailbox?`                           | same, Later view                                 |
| `/$ws/mail/done`, `/$ws/mail/done/$id`             | `mailbox?`                           | same, done view                                  |
| `/$ws/mail/archive`, `/$ws/mail/archive/$id`       | `mailbox?`                           | same, archive view                               |
| `/$ws/mail/all`, `/$ws/mail/all/$id`               | `mailbox?`                           | same, all mail                                   |
| `/$ws/mail/{drafts,sent,spam,trash}[/$id]`         | `mailbox?`                           | same, those folders                              |
| `/$ws/mail/search`, `/$ws/mail/search/$id`         | `q`, `mailbox?`                      | results for `q`; the thread                      |
| `/$ws/mail/compose`                                | `mailbox?`, `to?`, `subject?`        | (mailboxes come from the shell)                  |
| `/$ws/settings`, `/$ws/settings/$page`             |                                      | the settings page shown last (⌘. anywhere)       |
| `/$ws/files/my`, `/$ws/files/my/$folderId`         | `mailbox?`                           | a folder of My files                             |
| `/$ws/files/shared`, `/$ws/files/shared/$folderId` | `mailbox?`                           | a folder of Shared (companies only)              |
| `/$ws/files/shared-with-me`, `/$ws/files/trash`    | `mailbox?`                           | what was shared with you; Trash                  |
| `/s/$shareId`                                      | `node?`                              | a shared link, signed in or not; 404 → not found |
| `/$ws/crm/companies`, `/$ws/crm/people`            | `q?`, `mailbox?`                     | first page for `q` (company workspaces only)     |
| `/$ws/crm/deals`                                   | `q?`, `view?` (`list`), `mailbox?`   | the board's deals, or the list for `q`           |
| `/$ws/crm/{companies,people,deals}/$id`            | `mailbox?`                           | the record and its timeline's first page         |

Guards: `_authed` needs a user. `_authed/$workspace` resolves the slug, makes it the tab's
workspace (`lib/workspaces.ts` `enterWorkspace`: every API call sends `omni-workspace`, every
workspace query key carries its id, the session's active organization follows), moves a
`?mailbox=` or a thread of another workspace to that one, and needs the user's member there; it
loads mailboxes and counts for the shell. A user with no organization goes to `/onboarding` if
they may create one (always with open sign-up; owners only with `SIGN_UP=invitation`), else to `/login?error=no_organization`; an owner or
admin whose workspace's setup is unfinished (`member.setup !== "complete"`, from `/api/me`) goes
to `/onboarding`, which resumes at the saved step; `/$ws/settings` stays reachable. The thread routes are children of their list, so the
list stays mounted (three panes) and the back button walks the URL history.

## How the data layer works

**Calls.** `lib/api.ts` builds the typed client from `@omni/client` (Hono RPC over the Worker's
own route types, so a changed route is a type error here). `call()` unwraps a response or throws
`ApiError { status, message }`.

**Queries.** `lib/mail-queries.ts`, `lib/org-queries.ts` and `lib/session.ts` define each query
once with `queryOptions`. Route loaders start them (hovering a link preloads it); hooks subscribe
to the same keys. Keys live in `lib/query-keys.ts`. Lists and threads open at once: their loaders
don't wait, and the screen draws a `skullet` skeleton until the data is there (held back 150 ms,
so a quick load never shows it). Every screen's code loads once the app is idle
(`usePreloadScreens`), so a first visit doesn't wait on a download either.

**Startup.** `index.html` preloads what every signed-in screen asks for first (session, shell
data, the Inbox's first page) so it loads beside the scripts; `lib/startup-fetch.ts` hands each
answer to the first request for it, and drops what is left once the first screen has loaded or
the session changes.

**Freshness.** Mail is kept current by realtime, not polling. `staleTime` is 30 s, which only
bounds how long a missed event can leave something old. Window focus refetches stale queries.

**Realtime.** The `_member` shell calls `useRealtimeConnection(member.id)`, which opens the
websocket (`lib/realtime.ts`). A `changed` event marks the thread and the lists for that mailbox
stale (batched over 150 ms), plus counts and search; TanStack Query refetches the ones on screen.
The socket reconnects with jittered exponential backoff (0.5 s up to 30 s), and at once when the
browser comes online, the tab becomes visible again, or the API answers again after a failure.
After a reconnect every mail query is marked stale: the ones on screen refetch (joining any fetch
already running), the rest when next shown, and queued sends are checked against the outbox.
`useRealtimeStatus()` exposes `connecting | open | closed`. Helpdesk events: `thread.changed`,
`note.created` and `sla.*` mark the thread and its mailbox's lists stale like `changed`;
`action.succeeded` for a pending reply refetches its thread; `presence` fills `lib/presence.ts`,
whose entries expire after 70 s unless repeated (`useReportPresence` repeats every 30 s, again
on reconnect, and says `left` on unmount). A dropped socket clears presence.

**Conversations** (shared inboxes). `useConversation` is under the thread's key, so
anything that refetches the thread refetches it. The change hooks patch it at once, put it back
if the request fails, take the server's values on success, and refetch the thread, lists and
counts when they settle. Each offers its inverse as undo (resolve and snooze undo to reopen, so a
pending conversation comes back open).

**Helpdesk lists.** `useConversations({ mailbox, view, tag? })` is one inbox's view, paged by the
server's cursor; `/inbox?mailbox=…&view=…` loads it in the route loader. A change patches the row
in every cached list at once and drops it from lists it no longer fits (`inView` mirrors the
server's view rules; Mine needs your member, read from the inbox's cached assignees, and stays
put until the refetch when unknown). Undo works from a list row without the detail loaded.
Realtime refetches the lists of the inbox that changed and `useConversationCounts()`.

**Undo.** An action that can be reversed calls `offerUndo(label, inverse)` with the inverse built
from the state before it. One offer stands at a time for 8 s; `useUndo()` gives the toast its
`offer` and binds `z`. The list's done and later offer it already.

**Offline.** `lib/connectivity.ts` drives TanStack Query's `onlineManager`: offline when the
browser says so or a request got no answer at all, online again when the API answers (any
response, the socket opening, or a probe of `/api/me` with backoff). While offline, queries keep
their data and actions pause after their optimistic update; they run when the connection is back,
one at a time in the order they were made (one mutation `scope`), with the idempotency keys they
started with. `useConnectivity()` gives `{ online, queued }`; the sidebar shows a small badge
while offline. Queued actions live in memory: closing the tab while offline drops them.

**Optimistic updates.** Archive, read/unread, later and done change every cached list and the
thread at once (`lib/cache.ts`), then roll back if the request fails. Move just refetches.

**Done and Later** are yours alone, even on a shared mailbox. Later has no
time: a thread stays there until moved back (`useMoveToLater().mutate({ threadId, later })`). Pass the thread's
`lastMessageAt` as `through` when marking done: a newer message brings the thread back to the
Inbox, and one that arrived after the screen was drawn keeps it there.

**Sending.** `useSendReply().mutate({ threadId, text })` adds a pending reply to
`useThread(id).pending` right away (`sending` → `queued` → gone, or `failed` with `error`). The
Worker returns the Message-ID the mail service will use, so when the thread refetches with that
message, the pending entry is dropped. If the outbox gives up, a realtime `action` event marks it
`failed`. Failures of other actions (a new message, an archive) collect in
`useActionFailures()`.

**Idempotency.** Every outbox action carries an idempotency key. The action hooks mint one per
`mutate()` call, and TanStack's automatic retries (network errors only, waiting while offline)
reuse it, so a retry never sends twice, even when the first request arrived and only its answer
was lost.

**Identity changes.** Sign out, account switch, organization switch and invitation accept cancel in-flight
queries, clear the whole cache, and rerun the route guards (`resetSession`); the shell then
reconnects realtime for the new member. Any 401 does the same, which sends the user to `/login`.

## Hooks

| Hook                                                                                                                                                                                                   | Returns / takes                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `useSession()`                                                                                                                                                                                         | `{ user, session, member } \| null`                                                              |
| `useMember()`                                                                                                                                                                                          | `{ user, member }` (member routes only)                                                          |
| `useSignInMagicLink()`                                                                                                                                                                                 | `mutate({ email, redirect? })`                                                                   |
| `useSignInPasskey()`                                                                                                                                                                                   | `mutate()`                                                                                       |
| `useSignOut()`                                                                                                                                                                                         | `mutate()`                                                                                       |
| `useOrganizations()`, `useSetActiveOrganization()`                                                                                                                                                     | list; `mutate(organizationId)`                                                                   |
| `useInvitation(id)`, `useAcceptInvitation()`, `useRejectInvitation()`                                                                                                                                  | invitation; `mutate(id)`                                                                         |
| `useMembers()`, `useInvitations()`, `useInviteMember()`, `useCancelInvitation()`, `useRemoveMember()`, `useUpdateMemberRole()`                                                                         | organization admin                                                                               |
| `usePasskeys()`, `useAddPasskey()`, `useDeletePasskey()`                                                                                                                                               | passkeys                                                                                         |
| `useOnboarding()`, `useCreateWorkspace()`, `useAddDomain()`, `useCheckDomain()`, `useCreateMailboxes()`, `useFinishSetup()`, `useOnboardingExit()`                                                     | workspace setup (`hooks/use-onboarding.ts`)                                                      |
| `useWorkspaces()`, `useOpenWorkspace()`, `useOpenMailbox()`                                                                                                                                            | switcher (`hooks/use-workspaces.ts`)                                                             |
| `useMailboxes()`, `useCounts()`                                                                                                                                                                        | sidebar data                                                                                     |
| `useThreads({ view, mailbox?, lane? })`                                                                                                                                                                | `{ threads, fetchNextPage, hasNextPage, … }`                                                     |
| `useThread(id)`, `useSuspenseThread(id)`                                                                                                                                                               | `{ thread, pending, … }`                                                                         |
| `useSearch(q, mailbox?)`                                                                                                                                                                               | results                                                                                          |
| `usePrefetchThread()`                                                                                                                                                                                  | `(threadId) => void`                                                                             |
| `useMarkRead()`, `useMoveToLater()`, `useMarkDone()`, `useMarkUndone()`, `useArchive()`, `useMove()`                                                                                                   | `mutate({ threadId, … })`                                                                        |
| `useMarkReadOnOpen(thread)`                                                                                                                                                                            | marks an opened unread thread read, once                                                         |
| `useSendReply()`, `useSend()`                                                                                                                                                                          | `mutate({ … })`                                                                                  |
| `useDiscardPending()`, `useActionFailures()`                                                                                                                                                           | failed sends and actions                                                                         |
| `useRealtimeConnection(memberId)`, `useRealtimeStatus()`                                                                                                                                               | the socket                                                                                       |
| `useConnectivity()`                                                                                                                                                                                    | `{ online, queued }`                                                                             |
| `useShortcut(id, run, enabled?)`, `runShortcut(id)`, `useAvailableShortcuts()`, `announce(text)`                                                                                                       | keyboard shortcuts (`hooks/use-shortcuts.ts`)                                                    |
| `useConversation(threadId)`, `useTags(mailboxId)`, `useAssignees(mailboxId)`                                                                                                                           | helpdesk state, the inbox's tags and agents                                                      |
| `useResolve()`, `useReopen()`, `useSnooze()`, `useClaim()`, `useAssign()`, `useSetPriority()`, `useToggleTag()`                                                                                        | `mutate({ threadId, … })`, with undo                                                             |
| `useCreateTag()`, `useUpdateTag()`, `useDeleteTag()`                                                                                                                                                   | an inbox's tags (settings)                                                                       |
| `usePresence(threadId)`, `useReportPresence(thread, state)`                                                                                                                                            | who is viewing or replying; say you are                                                          |
| `useUndo()`, `offerUndo(label, undo)`                                                                                                                                                                  | `{ offer, undo, dismiss }` for the undo toast                                                    |
| `useThreadListShortcuts({ … })`                                                                                                                                                                        | the list keys: j/k, o, x, e, h, u, Esc                                                           |
| `useConversations(filter)`, `useConversationCounts()`                                                                                                                                                  | helpdesk lists (`conversations`, paging) and the navigation's counts                             |
| `useThreadListShortcuts({ …, helpdesk: { filter, conversations } })`                                                                                                                                   | on a helpdesk list e/h/i resolve, snooze, assign to me (one bulk request, one undo)              |
| `useBulkChange()`                                                                                                                                                                                      | `run(threadIds, change, { mailboxId, tag?, undo? })`: one request per 100, failed rows roll back |
| `useStorageList(place)`, `useStorageTrash()`, `useSharedWithMe()`, `useStorageLink(shareId, node?)`, `useStorageUsage()`                                                                               | Storage: folders, Trash, shared with you, a link's contents, usage                               |
| `useCreateFolder()`, `useChangeNode()`, `useTrashNode()`, `useRestoreNode()`, `useDeleteForever()`, `useUploads()`                                                                                     | changes and uploads; pass `shareId` to go through a link's door (an Editor)                      |
| `useStorageSharing(id)`, `usePutStoragePerson()`, `useRemoveStoragePerson()`, `useSetStorageLink()`                                                                                                    | who an item is shared with, and its link                                                         |
| `useCrmCompanies(q)`, `useCrmPeople(q)`, `useCrmDeals(q, { all? })`, `useCrmCompany(id)`, `useCrmPerson(id)`, `useCrmDeal(id)`, `useCrmTimeline(kind, id)`, `useCrmContracts(where)`, `useCrmStages()` | the CRM; `crm.changed` marks all of it stale                                                     |
| `useMoveDeal()`, `useCreate*()`, `useUpdate*()`, `useCreateNote()`, `useRecordFolder()`, `useCreateContract()`, `useUpdateContract()`, `usePutStages()`                                                | CRM changes; a deal's move is optimistic with rollback                                           |
| `useSlaSettings(mailboxId)`                                                                                                                                                                            | `{ policies, businessHours, autoAssign }` for an inbox                                           |
| `usePutSlaPolicy()`, `useDeleteSlaPolicy()`, `usePutBusinessHours()`, `useDeleteBusinessHours()`, `useSetAutoAssign()`                                                                                 | inbox SLA settings (owners and admins; optimistic, rollback)                                     |

Message HTML goes in a sandboxed iframe: `messageHtmlUrl(threadId, messageId)`; attachments:
`attachmentUrl(threadId, attachmentId)` (`lib/urls.ts`).

## Keyboard shortcuts

`lib/shortcuts.ts` is the one definition: id, label, keys. The shell mounts one document listener
(`useShortcutListener`) and the `?` list (`components/shell/keyboard-shortcuts.tsx`), both read
from that table. A screen binds what a key does with `useShortcut(id, run)`. `/` and ⌘K are
listed there but bound by the title-bar search popover; its command rows are `COMMAND_IDS`,
filtered by `useAvailableShortcuts()` (what the screen handles right now) and run with
`runShortcut(id)`, so a command and its key can't disagree. Keys never fire in a field, a dialog
or a menu, or when a focused widget already handled them (React Aria's list moves on the arrows
and opens on Enter). The list cursor is real focus on a row, so screen readers follow it; actions
announce what they did in a polite live region.

## Not yet

- Drafts, labels, manual triage re-sort, shared-inbox assignment ("v1 scope").

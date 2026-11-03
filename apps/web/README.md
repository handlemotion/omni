# @omni/web

The web app: a Vite + React single-page app on TanStack Router and TanStack Query. The Worker
serves the built files and `/api` on one origin, so the session cookie is first-party and there
is no CORS. Design decisions: `docs/adr/0006-web-app-foundation.md`.

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

| Path                         | Search params                 | Loader                                      |
| ---------------------------- | ----------------------------- | ------------------------------------------- |
| `/`                          |                               | redirect to `/inbox`                        |
| `/login`                     | `redirect?`, `error?`         | signed-in members are sent on to `redirect` |
| `/invite/$invitationId`      |                               | the invitation (any signed-in user)         |
| `/onboarding`                |                               | setup status (may create, or finishing one) |
| `/inbox`, `/inbox/$threadId` | `mailbox?`, `lane?`           | first page of the list; the thread          |
| `/queue`, `/queue/$id`       | `mailbox?`                    | same, queue (deferred) view                 |
| `/done`, `/done/$id`         | `mailbox?`                    | same, done view                             |
| `/archive`, `/archive/$id`   | `mailbox?`                    | same, archive view                          |
| `/all`, `/all/$id`           | `mailbox?`                    | same, all mail                              |
| `/search`, `/search/$id`     | `q`, `mailbox?`               | results for `q`; the thread                 |
| `/compose`                   | `mailbox?`, `to?`, `subject?` | (mailboxes come from the shell)             |
| `/settings`                  |                               | organizations, passkeys                     |
| `/settings/organization`     |                               | members, invitations                        |

Guards: `_authed` needs a user, `_authed/_member` needs a member of the active organization and
loads mailboxes and counts for the shell. A user with no organization goes to `/onboarding` if
they may create one (`ORGANIZATION_CREATION`), else to `/login?error=no_organization`; an owner or
admin whose workspace has no mailboxes goes to `/onboarding` to finish it (ADR 0007). The thread routes are children of their list, so the
list stays mounted (three panes) and the back button walks the URL history.

## How the data layer works

**Calls.** `lib/api.ts` builds the typed client from `@omni/client` (Hono RPC over the Worker's
own route types, so a changed route is a type error here). `call()` unwraps a response or throws
`ApiError { status, message }`.

**Queries.** `lib/mail-queries.ts`, `lib/org-queries.ts` and `lib/session.ts` define each query
once with `queryOptions`. Route loaders `ensureQueryData` them (so a route renders with data, and
hovering a link preloads it); hooks subscribe to the same keys. Keys live in `lib/query-keys.ts`.

**Freshness.** Mail is kept current by realtime, not polling. `staleTime` is 30 s, which only
bounds how long a missed event can leave something old. Window focus refetches stale queries.

**Realtime.** The `_member` shell calls `useRealtimeConnection(member.id)`, which opens the
websocket (`lib/realtime.ts`). A `changed` event marks the thread and the lists for that mailbox
stale (batched over 150 ms), plus counts and search; TanStack Query refetches the ones on screen.
The socket reconnects with jittered exponential backoff (0.5 s up to 30 s), and at once when the
browser comes online, the tab becomes visible again, or the API answers again after a failure.
After a reconnect every mail query is marked stale: the ones on screen refetch (joining any fetch
already running), the rest when next shown, and queued sends are checked against the outbox.
`useRealtimeStatus()` exposes `connecting | open | closed`.

**Offline.** `lib/connectivity.ts` drives TanStack Query's `onlineManager`: offline when the
browser says so or a request got no answer at all, online again when the API answers (any
response, the socket opening, or a probe of `/api/me` with backoff). While offline, queries keep
their data and actions pause after their optimistic update; they run when the connection is back,
one at a time in the order they were made (one mutation `scope`), with the idempotency keys they
started with. `useConnectivity()` gives `{ online, queued }`; the sidebar shows a small badge
while offline. Queued actions live in memory: closing the tab while offline drops them.

**Optimistic updates.** Archive, read/unread, defer and done change every cached list and the
thread at once (`lib/cache.ts`), then roll back if the request fails. Move just refetches.

**Done and defer** are yours alone, even on a shared mailbox (ADR 0007). Pass the thread's
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

| Hook                                                                                                                           | Returns / takes                              |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `useSession()`                                                                                                                 | `{ user, session, member } \| null`          |
| `useMember()`                                                                                                                  | `{ user, member }` (member routes only)      |
| `useSignInMagicLink()`                                                                                                         | `mutate({ email, redirect? })`               |
| `useSignInPasskey()`                                                                                                           | `mutate()`                                   |
| `useSignOut()`                                                                                                                 | `mutate()`                                   |
| `useOrganizations()`, `useSetActiveOrganization()`                                                                             | list; `mutate(organizationId)`               |
| `useInvitation(id)`, `useAcceptInvitation()`, `useRejectInvitation()`                                                          | invitation; `mutate(id)`                     |
| `useMembers()`, `useInvitations()`, `useInviteMember()`, `useCancelInvitation()`, `useRemoveMember()`, `useUpdateMemberRole()` | organization admin                           |
| `usePasskeys()`, `useAddPasskey()`, `useDeletePasskey()`                                                                       | passkeys                                     |
| `useOnboarding()`, `useCreateWorkspace()`, `useAddDomain()`, `useCheckDomain()`, `useCreateMailboxes()`                        | workspace setup (`hooks/use-onboarding.ts`)  |
| `useMailboxes()`, `useCounts()`                                                                                                | sidebar data                                 |
| `useThreads({ view, mailbox?, lane? })`                                                                                        | `{ threads, fetchNextPage, hasNextPage, … }` |
| `useThread(id)`, `useSuspenseThread(id)`                                                                                       | `{ thread, pending, … }`                     |
| `useSearch(q, mailbox?)`                                                                                                       | results                                      |
| `usePrefetchThread()`                                                                                                          | `(threadId) => void`                         |
| `useMarkRead()`, `useDefer()`, `useMarkDone()`, `useMarkUndone()`, `useArchive()`, `useMove()`                                 | `mutate({ threadId, … })`                    |
| `useMarkReadOnOpen(thread)`                                                                                                    | marks an opened unread thread read, once     |
| `useSendReply()`, `useSend()`                                                                                                  | `mutate({ … })`                              |
| `useDiscardPending()`, `useActionFailures()`                                                                                   | failed sends and actions                     |
| `useRealtimeConnection(memberId)`, `useRealtimeStatus()`                                                                       | the socket                                   |
| `useConnectivity()`                                                                                                            | `{ online, queued }`                         |

Message HTML goes in a sandboxed iframe: `messageHtmlUrl(threadId, messageId)`; attachments:
`attachmentUrl(threadId, attachmentId)` (`lib/urls.ts`).

## Not yet

- Drafts, labels, manual triage re-sort, shared-inbox assignment (ADR 0006, "v1 scope").

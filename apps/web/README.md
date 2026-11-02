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

## Layout

```
src/
  main.tsx           query client + router
  router.ts          router options (preload on intent) and its typed context
  routes/            the path map; each route = guard + loader + placeholder component
  lib/               data layer: no React components, no styling
  hooks/             what components call
  components/        UI (Rodrigo's)
```

Components use `hooks/` only. `lib/` is how the hooks work.

## Path map

| Path                         | Search params                 | Loader                                      |
| ---------------------------- | ----------------------------- | ------------------------------------------- |
| `/`                          |                               | redirect to `/inbox`                        |
| `/login`                     | `redirect?`, `error?`         | signed-in members are sent on to `redirect` |
| `/invite/$invitationId`      |                               | the invitation (any signed-in user)         |
| `/inbox`, `/inbox/$threadId` | `mailbox?`, `lane?`           | first page of the list; the thread          |
| `/snoozed`, `/snoozed/$id`   | `mailbox?`                    | same, snoozed view                          |
| `/archive`, `/archive/$id`   | `mailbox?`                    | same, archive view                          |
| `/search`, `/search/$id`     | `q`, `mailbox?`               | results for `q`; the thread                 |
| `/compose`                   | `mailbox?`, `to?`, `subject?` | (mailboxes come from the shell)             |
| `/settings`                  |                               | organizations, passkeys                     |
| `/settings/organization`     |                               | members, invitations                        |

Guards: `_authed` needs a user, `_authed/_member` needs a member of the active organization and
loads mailboxes and counts for the shell. The thread routes are children of their list, so the
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
After a reconnect everything mail-related is refetched, and queued sends are checked against the
outbox. `useRealtimeStatus()` exposes `connecting | open | closed`.

**Optimistic updates.** Archive, read/unread and snooze change every cached list and the thread
at once (`lib/cache.ts`), then roll back if the request fails. Move just refetches.

**Sending.** `useSendReply().mutate({ threadId, text })` adds a pending reply to
`useThread(id).pending` right away (`sending` → `queued` → gone, or `failed` with `error`). The
Worker returns the Message-ID the mail service will use, so when the thread refetches with that
message, the pending entry is dropped. If the outbox gives up, a realtime `action` event marks it
`failed`. Failures of other actions (a new message, an archive) collect in
`useActionFailures()`.

**Idempotency.** Every outbox action carries an idempotency key. The action hooks mint one per
`mutate()` call, and TanStack's automatic retries (network errors only) reuse it, so a retry
never sends twice.

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
| `useMailboxes()`, `useCounts()`                                                                                                | sidebar data                                 |
| `useThreads({ view, mailbox?, lane? })`                                                                                        | `{ threads, fetchNextPage, hasNextPage, … }` |
| `useThread(id)`, `useSuspenseThread(id)`                                                                                       | `{ thread, pending, … }`                     |
| `useSearch(q, mailbox?)`                                                                                                       | results                                      |
| `usePrefetchThread()`                                                                                                          | `(threadId) => void`                         |
| `useMarkRead()`, `useSnooze()`, `useArchive()`, `useMove()`                                                                    | `mutate({ threadId, … })`                    |
| `useMarkReadOnOpen(thread)`                                                                                                    | marks an opened unread thread read, once     |
| `useSendReply()`, `useSend()`                                                                                                  | `mutate({ … })`                              |
| `useDiscardPending()`, `useActionFailures()`                                                                                   | failed sends and actions                     |
| `useRealtimeConnection(memberId)`, `useRealtimeStatus()`                                                                       | the socket                                   |

Message HTML goes in a sandboxed iframe: `messageHtmlUrl(threadId, messageId)`; attachments:
`attachmentUrl(threadId, attachmentId)` (`lib/urls.ts`).

## Not yet

- Drafts, labels, manual triage re-sort, shared-inbox assignment (ADR 0006, "v1 scope").

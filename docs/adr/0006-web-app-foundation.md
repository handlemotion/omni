# 0006: Web app foundation (`apps/web`) and the API it needs

Date: 2026-11-02 · Status: accepted

## Context

`apps/web` does not exist yet. Rodrigo builds every component, layout and style; this change
builds what sits underneath: routing, the data layer, realtime, auth wiring and headless hooks.
The backend is mostly ready (Hono API, `@omni/client`, realtime Durable Object). Reading it
against the web app's needs turned up gaps, listed under "API gaps".

Most choices follow the spec. The departures are: the web app lives on its own subdomain served
by the Worker; Better Auth invitations, organization switching and multi-session land in v1
(spec: login only); and the mail service reports failed actions to the Worker.

## Decisions

### Stack

- **Vite + React SPA (single-page app), TanStack Router + TanStack Query**, as the spec says.
  TanStack Start stays rejected: everything is behind a login, so server rendering buys nothing.
- **Same origin.** The one Worker serves the built SPA (Workers Static Assets) and `/api` on
  `inbox.omnidirectional.app`. The session cookie stays first-party; no CORS. In dev, Vite proxies `/api`
  (websocket included) to `wrangler dev`, so dev is same-origin too.
- **Domains.** The app is `inbox.omnidirectional.app`. The bare domain `omnidirectional.app`
  keeps the mail (MX at Purelymail) and is free for a marketing site with its own tooling and
  deploys; sharing `/` between marketing and the app would tangle routes, caching and releases.
  Passkeys use the bare domain as relying party ID (`AUTH_PASSKEY_RP_ID=omnidirectional.app`), so
  they work on every subdomain and survive moving the app. For iOS passkeys (M5) the bare domain
  serves `/.well-known/apple-app-site-association`. In code it is all config.
- **Typed calls from `@omni/client`** (Hono RPC over the Worker's `AppType`). No codegen, no
  hand-written client.
- **Realtime: the existing per-org Durable Object websocket** via `connectRealtime`. S2 stays
  rejected (it stores events but runs no code). Events say _what_ changed, so the cache
  invalidates and refetches only queries that are on screen; a reconnect refetches everything
  visible.

### Route map

All signed-in routes sit under one `_authed` layout whose guard reads the cached session and
redirects to `/login?redirect=…` on 401. Each list has a nested `$threadId` child, so three panes,
deep links and the back button work. Cursor pagination lives in the query cache, not the URL.

| Path                             | Search params                            | Loader fetches                                 |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `/`                              |                                          | redirect to `/inbox`                           |
| `/login`                         | `redirect?`, `error?`                    | nothing (signed-out only)                      |
| `/invite/$invitationId`          |                                          | invitation (accept or decline)                 |
| `/inbox`                         | `mailbox?`, `lane?` (absent = all lanes) | mailboxes + counts (layout), first thread page |
| `/inbox/$threadId`               | inherited                                | thread (prefetched on hover/focus in the list) |
| `/snoozed`, `/snoozed/$threadId` | `mailbox?`                               | snoozed threads                                |
| `/archive`, `/archive/$threadId` | `mailbox?`                               | archived threads                               |
| `/search`, `/search/$threadId`   | `q`, `mailbox?`                          | search results                                 |
| `/compose`                       | `mailbox?`, `to?`, `subject?`            | mailboxes                                      |
| `/settings`                      |                                          | me, passkeys, device sessions                  |
| `/settings/organization`         |                                          | organization, members, pending invitations     |

### Data flow

```
component → hook (src/hooks) → query/mutation options (src/lib/queries) → @omni/client → Worker
                                        ↑
            realtime (src/lib/realtime) ── invalidates query keys on events
```

- **Query keys** are one factory (`src/lib/query-keys.ts`). They do not carry the org id: any
  identity change cancels in-flight queries and clears the whole cache instead (below), which is
  simpler and equally safe.
- **Freshness:** lists and threads are `staleTime: 30s`; realtime is what makes them current,
  the stale time only bounds a missed event. Counts refetch with any list invalidation.
- **Optimistic updates:** archive, read/unread, snooze and move patch every cached list and the
  thread at once, then roll back if the request fails. Each mutation sends one idempotency key
  per user intent, reused on retry.
- **Send/reply** return `{ actionId, messageIdHeader }`. A pending message is added to the
  thread right away; the refetched thread replaces it when it holds the same Message-ID. A
  realtime `action` event (or `GET /api/actions/:id` after a reconnect) marks it failed.
- **Org or account switch, sign out, any 401:** cancel in-flight queries, clear the query cache,
  rerun the route guards; the shell reopens the realtime socket for the new member (the Durable
  Object is per org).

### Hook and lib surface (`src/lib`, `src/hooks`; components live in `src/components`)

- Session and auth: `useSession`, `useSignInMagicLink`, `useSignInPasskey`, `useAddPasskey`,
  `useSignOut`, `useDeviceSessions`, `useSwitchAccount`, `useOrganizations`,
  `useSetActiveOrganization`, `useMembers`, `useInvitations`, `useInviteMember`,
  `useAcceptInvitation`.
- Mail reads: `useMailboxes`, `useCounts`, `useThreads({ mailbox, lane, view })` (infinite),
  `useThread(id)`, `useSearch({ q, mailbox })`, `usePrefetchThread`.
- Mail writes: `useSendReply`, `useSend`, `useArchive`, `useMarkRead`, `useSnooze`, `useMove`.
- Realtime: `useRealtimeStatus` (`connecting | open | closed`); the connection itself is
  started once by the `_authed` layout.
- Display helpers (pure): message HTML and attachment URLs, image-proxy URLs.

### Thread data shape

One shape that both views read, computed by the Worker so iOS gets it too:

- **List row:** existing thread fields plus `subject`, `snippet`, `latestFrom`, `participants`,
  `messageCount`, `unread`, `hasAttachments`.
- **Message:** existing fields plus `fromMe`, `display: "bubble" | "card"` (a pure rule in
  `mail-core`: over about 120 words is a card), `hasHtml` (replaces exposing R2 keys), and
  `addedParticipants` (for "Ana added Luis").
- Email mode reads `hasHtml` and the HTML route. Chat mode reads `cleanText`, `fromMe`, `display`.
  The spec's "tables make it a card" rule needs the HTML, so it waits.

### v1 scope

In: magic link and passkey login, invitations, organization switching, multiple signed-in
accounts, mailbox switcher, triage lanes, thread list, snoozed and archive views, thread view
(summary, HTML toggle, attachments, proxied images), reply and reply-all, compose, archive,
read/unread, snooze, move, search, failed-send state.

Later: drafts, labels (Omni has folders and move), manual triage re-sort, shared-inbox
assignment (M4).

## API gaps and who closes them

One stack, bottom-first:

1. **Auth (separate cloud session).** Better Auth invitations (emails through the outbox, like
   magic links), organization switching, the `multiSession` plugin; client plugins in
   `@omni/client`; sign-up limited to invited emails plus a CLI for the first org and owner;
   magic-link URL printed to the console under `ENVIRONMENT=development`; docs.
2. **Mail API gaps.** List row and message fields above; `/inbox` hides snoozed threads until
   their time and a `snoozed` view lists them; `GET /api/counts`; send and reply return
   `messageIdHeader`; the mail service reports a permanently failed action to the Worker, which
   pushes `{ type: "action", actionId, status, error }`; `GET /api/actions/:id`.
3. **`apps/web`.** The foundation above. Built against the agreed shapes while 1 and 2 are in
   review; rebased on them before it merges.

Layer 1 landed as #48 and layer 2 as #50. In #50 the Worker picks the Message-ID and passes it in
the send payload, and the realtime `action` event carries no `kind`; the web app follows #50.

Layers 1 and 2 both touch `apps/worker` (1: `context.ts`, `packages/auth`, new org routes if any;
2: `routes/mail.ts`, `packages/db/src/for-member.ts`, `mail-core`, `contracts`, `apps/mail`).
Keeping them in one stack follows the "two stacks never edit the same package" rule.

## Open questions

- Do new members join by invitation only, or may an owner allow open sign-up for the org's email
  domain? Default: invitation only.

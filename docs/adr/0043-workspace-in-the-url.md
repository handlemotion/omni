# 0043: The workspace is in the URL, and every request names it

Date: 2026-11-16 · Status: accepted · Amends: ADR 0006 (web app paths), ADR 0014 (workspace
isolation)

## Context

The web app's paths came from when Omni was mail alone: `/inbox`, `/all/<id>`, `/files/my`,
`/settings`. The workspace lived only in the session's active organization, which every tab of a
browser shares, and query keys did not carry it (a switch cleared the whole cache). So:

- Two tabs in two workspaces could not exist. Switching in one tab switched the other's session,
  and the other tab's next refetch (focus, realtime) filled its Acme screens with Beta's mail.
  The founder saw mail from another workspace in a workspace, until the list changed.
- The back button, a bookmark or a link to `/inbox?mailbox=<id>` opened a list of one workspace
  under another's sidebar.
- No URL said which workspace it was for, so a link could not be shared.

Better Auth's organization docs say the active organization does not have to live in the
session, and that it can be kept on the client so tabs can differ ("Active Organization").
TanStack Query's guide says a key must carry everything its fetch depends on.

## Decision

1. **Paths start with the workspace's slug, and mail has its own prefix.**
   `/<slug>/mail/{inbox,later,done,archive,all,search,compose,drafts,sent,spam,trash}[/<id>]`,
   `/<slug>/files/…`, `/<slug>/crm/…`, `/<slug>/settings/<page>`. `/` opens the session's
   workspace's Inbox. Pages outside a workspace stay where they were (`/login`, `/onboarding`,
   `/join`, `/invite/<id>`, `/s/<id>`, `/settings/emails/verify`, `/oauth/consent`).
2. **The URL is the tab's workspace.** The `$workspace` route resolves the slug against
   `GET /api/workspaces` (read again once when the cached list lacks it). A `?mailbox=` of another
   of the user's workspaces, or a thread opened by link whose `orgId` is another workspace, moves
   the page to that workspace's slug. A slug the user has no workspace for is a path from before
   this ADR (`/inbox/<id>`, `/settings/billing`) and is sent on under the session's workspace, so
   every old link, bookmark, magic-link callback and Worker-made URL still opens.
3. **Every API call names its workspace.** The web app sends `omni-workspace: <orgId>` (one
   constant in `@omni/contracts/headers`). `resolveSession` reads the member in that workspace,
   so `requireMember` and every route behind it answer for the tab's workspace. Membership is
   checked as before (`findMember` with the user and the org; a session scoped to a company finds
   nothing outside it), so a workspace the user is not in is a 403, never the session's data.
   Without the header (iOS, old tabs) the session's active organization is used, as before. Thread
   routes still act as the member who can see the thread (ADR 0014).
4. **Answers say which workspace they were read from.** Member-scoped responses carry
   `omni-workspace` back. A startup preload (sent before the app knows its URL's workspace) that
   answered for another workspace is dropped and asked again.
5. **Query keys carry the workspace.** The `org`, `mail`, `storage` and `crm` branches sit under
   the org id (`["omni", <orgId>, "mail", …]`). Two workspaces never share a cache entry, so one's
   answer cannot render in the other's screens, and a switch does not clear the cache: going back
   to a workspace is served from it. The person's own data (session, the workspace list, the
   accounts on the browser, sends waiting on a result) stays unscoped.
6. **The session follows the tab.** Entering a workspace sets the session's active organization
   to it (one request, beside reading the member there), so the next load's preloads and clients
   that name no workspace agree. Better Auth's organization calls in settings pass the tab's
   `organizationId` explicitly, so another tab's switch cannot redirect an invite or a role change.

## Consequences

- Isolation no longer depends on which tab switched last. Proven in
  `apps/worker/e2e/all-workspaces.e2e.test.ts` (the header wins over the session, both ways; a
  foreign workspace is 403) and `apps/web/e2e/mailbox-switcher.e2e.test.ts` (switches, modules,
  a thread opened by link moving to its workspace).
- The ADR 0014 amendment's sockets for "another workspace's thread on screen" mostly stop being
  needed: such a thread now moves the page to its workspace. Sockets for sends from another
  workspace's address stay.
- A Personal space's slug is `personal-<uuid>`, so its URLs are long. Renaming a workspace's
  handle changes its URLs; an old one falls back to the session's workspace's Inbox.
- Worker-made links (MCP's `/all/<id>`, CRM record links, settings returns) still use the old
  paths and rely on the legacy redirect. They can move to slugged paths later; nothing breaks
  meanwhile.

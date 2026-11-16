# 0046: Failures in the web app

Date: 2026-11-16 · Status: accepted · Extends: ADR 0038 (API errors, and Effect in the Worker)

## Context

The web app had no error boundaries of its own. Any failure a route could not render fell to
TanStack Router's last-resort boundary, a bare "Something went wrong!". The commonest one came
from deploys: a window opened before a deploy asks for a lazy chunk (a route, the PDF preview)
whose file the new build no longer has; the server answers the app's HTML, and the import fails
with "'text/html' is not a valid JavaScript MIME type". Reloading fixes it, and nothing told
anyone to.

The Worker already answers typed errors (ADR 0038): a stable `code`, a `category`, `retryable`
and a `requestId`, which `ApiError` (`apps/web/src/lib/api.ts`) carries. The app did not use
them: queries retried everything but 401 and 403, and about 125 `onError` sites each wrote their
own toast, or none.

## Decision 1: one classification, a handful of kinds

`classify(error)` (`apps/web/src/lib/failure.ts`) turns anything thrown into a `Failure`
`{ kind, retryable, code?, requestId?, cause }`. Boundaries, retries and toasts decide on `kind`,
never on a message.

| Kind              | From                                                                         | Retryable          |
| ----------------- | ---------------------------------------------------------------------------- | ------------------ |
| `stale_build`     | a failed dynamic import or module script, in any engine's wording            | yes (by reloading) |
| `offline`         | `ApiError` status 0 (no answer), a `fetch` `TypeError`                       | yes                |
| `unauthenticated` | category `unauthenticated` (401)                                             | no                 |
| `permission`      | category `permission` (403)                                                  | no                 |
| `not_found`       | category `not_found` (404, 410)                                              | no                 |
| `refused`         | categories `validation`, `conflict`, `payload_too_large`, `quota`, `billing` | no                 |
| `rate_limit`      | category `rate_limit` (429)                                                  | yes                |
| `unavailable`     | category `unavailable` (502, 503, 504)                                       | yes                |
| `server`          | category `internal` (500)                                                    | as the Worker says |
| `bug`             | anything else: our own code threw                                            | no                 |

An answer without a category (Better Auth's own, an old Worker) falls back to its status. The
Worker's `retryable` wins over the kind's default. `Failure` is a tagged union shaped like
Effect's `Data.TaggedError`, so a `switch` on `kind` is exhaustive.

## Decision 2: containment in layers

A failure takes down the smallest part of the screen that cannot work without it:

1. **The root page.** The root route's error component is the 500 page: what happened, the
   request ID to quote, Reload. It replaces TanStack's bare text.
2. **A module's routes.** Each module's layout route (Mail, Storage, CRM, Settings) has its own
   error component, so a failed loader or render keeps the shell and the sidebar.
3. **Previews.** A file preview (PDF, media, code) sits in its own boundary, so a broken file
   shows a broken preview, not a broken page.

These components belong to the UI change built beside this one. Below them,
`router.ts` sets `defaultOnCatch`: every failure a route's boundary catches is classified once,
reloads when it is `stale_build`, and goes to Sentry when it is `bug` or `server`. TanStack calls
it only from a route that has an error component (its own or the router's default), so it takes
effect with the layers above.

## Decision 3: a stale build reloads once

`main.tsx` listens for Vite's `vite:preloadError`, which Vite 8 dispatches when a lazy chunk or
its preloads fail, and calls `reloadForUpdate()`. That reloads unless it already reloaded within
60 seconds (a timestamp in `sessionStorage`), or the app is offline (a reload would land on the
browser's own error page). Only when it reloads does it `preventDefault()`; otherwise the error
goes on to the route's boundary, which shows it. One stale window costs one reload; a chunk that
is truly missing costs at most two (TanStack's `lazyRouteComponent` reloads once of its own per
missing module and session) and then shows the error page, never a loop.

While a reload is under way nothing is reported: what fails as the page goes away is noise.

## Decision 4: retries, reports and toasts

- **Queries retry** only a `retryable` failure (offline, rate limit, unavailable, or what the
  Worker marks retryable), at most twice, and never `unauthenticated` or `permission`. A 404 or
  a refusal answers the same the second time.
- **A 401 anywhere** still ends the session (`onSessionLost`, unchanged).
- **Reports.** The query and mutation caches and `defaultOnCatch` pass every failure to
  `reportFailure`, which sends only `bug` and `server` to Sentry, tagged with the kind and request
  ID. Sentry marks an error object once captured, so a failure seen by a query and by the route
  that loaded it is sent once. Sentry's own global handlers keep catching what nothing caught
  (`window.onerror`, unhandled rejections); React boundaries swallow errors, so routes report
  through `defaultOnCatch`.
- **A failed mutation toasts by default.** The mutation cache shows `failureMessage(failure)`:
  "You're offline.", "Something went wrong. Try again.", the Worker's own sentence for a
  refusal, and so on; nothing for `unauthenticated` (the sign-in redirect speaks). One toast per
  kind at a time, so ten actions failing offline show one.
- **Opting out.** A mutation whose every caller tells the person itself (its own toast with a
  sentence for the action, an inline problem, a dialog's error) declares
  `meta: { handlesError: true }` where it is defined. A caller's per-call `onError` is invisible
  to the cache, so the mark goes on the definition, and only when every call site handles it.
  On 2026-11-16, 90 definitions carried it; the default toast covers the rest: a conversation's
  status, assignee, priority, tags and bulk changes, read, Later, done and trash (which rolled
  back without a word before), notifications read, signing in with a link, Google or a passkey,
  signing out, switching account, and leaving setup.

## Decision 5: no Effect in the web app

Effect stays where ADR 0009 and ADR 0038 put it: the mail service's edges and the Worker's jobs.
The web app does not adopt it.

- **Cost.** Effect's core is about 39 KB gzip (ADR 0038's measurement), and it would sit in the
  entry chunk every screen waits for.
- **No gap to fill.** React's boundaries and TanStack Router already contain a failure to a
  route, TanStack Query already owns retries and cancellation, and the failures worth
  distinguishing are a handful of kinds, not a typed error channel through every call.
- **A cheap way back.** `Failure` is a tagged union shaped like Effect's tagged errors, so moving
  the app to Effect later turns `classify` into the edge where `Effect.tryPromise` maps causes,
  mechanically.

## Consequences

- An old window recovers by itself after a deploy, at the cost of one reload.
- A failed action is never silent: it shows its own sentence or the default one.
- A new mutation toasts on failure unless it says otherwise; one that adds its own `onError`
  toast at every call site must also add `meta: { handlesError: true }`, or the person sees two.
- Queries stop retrying 404s, refusals and 500s the Worker does not mark retryable, so those
  screens fail faster.

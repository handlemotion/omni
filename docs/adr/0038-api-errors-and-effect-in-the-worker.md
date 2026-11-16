# 0038: API errors, and Effect in the Worker

Date: 2026-11-16 · Status: accepted · Extends: ADR 0009 (Effect at the mail service's edges),
ADR 0035 (adds a platform piece)

## Context

The Worker answered errors in several shapes. `onError` and the validator sent
`{ error, requestId }`; Storage sent `{ error, code, requestId }` with upper-case codes
(`STORAGE_FULL`); the billing gate sent `{ error, code }` with no request ID; the rate limiter
sent `{ error }`; a dozen routes built `{ error }` by hand, some with extra fields (`issues`,
`draft`, `messages`, `conversation`). About 16 codes existed, all from Storage and billing.
Every client (`apps/web`, `apps/ios`, `@omni/client`, `apps/mail`) read only the message string
and branched on the HTTP status; none read `code`.

Old browser tabs and installed iOS builds keep calling new Workers (AGENTS.md "expand, then
contract"), so `error` cannot simply turn from a string into an object.

Effect v4 already runs at the mail service's edges (ADR 0009), which named the Worker's AI queue
consumer as the next candidate.

The founder decided both points on 2026-11-16.

## Decision 1: one error format, Vercel's nested shape

**Shape.** Like [Vercel's REST API errors](https://vercel.com/docs/rest-api/errors):

```json
{
  "error": {
    "code": "storage_full",
    "message": "this workspace's storage is full",
    "category": "quota",
    "retryable": false,
    "requestId": "…",
    "param": "name",
    "details": { "issues": [{ "path": ["name"], "code": "too_small", "message": "…" }] },
    "limit": { "remaining": 0, "reset": 1795000000, "resetMs": 1795000000000, "total": 10 }
  }
}
```

- `code` is lower-case snake_case, stable, and what clients branch on. Generic codes
  (`bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`,
  `internal_server_error`, …) cover every refusal without a code of its own; domain codes
  (`storage_full`, `billing_inactive`, `name_taken`, …) are added where a client acts on them.
- `category` is one of `validation`, `unauthenticated`, `permission`, `not_found`, `conflict`,
  `payload_too_large`, `rate_limit`, `quota`, `billing`, `unavailable`, `internal`.
- `retryable` says whether the same request may succeed later unchanged (`rate_limited`,
  `bad_gateway`, `gateway_timeout`).
- `requestId` is always there. `param` (the first offending field) and `details.issues`
  (path, zod code and message per issue, never the input) come with validation errors. `limit`
  comes with rate limits, beside `retry-after` and `X-RateLimit-Limit/Remaining/Reset`.
- A response that carries data beside its error (a draft conflict's `draft`, a stale reply's
  `messages`, a conversation change's `conversation`) keeps that data at the top level, beside
  `error`, in both shapes.

**One table.** `packages/contracts/src/errors.ts` holds `ERROR_CODES`: each code with exactly
one status, category and `retryable`. `codeForStatus` gives a status's generic code. The zod
schemas of both shapes are in `error-schemas.ts`; `errors.ts` stays zod-free because clients
load it into the web app's entry chunk (`@omni/contracts/errors`).

**Negotiated by a header.** A request with `omni-error-format: 2` gets the nested shape. Any
other request gets the legacy shape: `error` stays the message string and the same fields sit
flat beside it (`{ error, code, category, retryable, requestId, … }`), which old clients ignore.
`@omni/client`'s `createApi` sends the header on every call, so the web app and new iOS builds
get the nested shape; `toApiError` reads either. No CORS allowlist is involved: the web app and
`/api` share an origin (ADR 0006) and iOS is native, so the Worker sends no CORS headers at all
and the header needs none.

**One path in the Worker.** `apps/worker/src/errors.ts` builds every error answer (`apiError`,
`errorBody`) and `onError` (`answerThrown`) maps every thrown refusal to a code in one place:
`ApiFailure` (a code of its own), Hono's `HTTPException`, `DomainError` and `MailServiceError`
(their status's generic code), and anything else to a 500 `internal_server_error` that says
nothing and is logged.

**Out of scope.** Better Auth's own answers under `/api/auth/*` (its `{ code, message }` bodies,
including `PERSONAL_SPACE` and `SESSION_SCOPED` from `@omni/auth`), and MCP's JSON-RPC and OAuth
errors at `/mcp` (`invalid_token`, `insufficient_scope`), keep the formats their protocols and
libraries define.

**A platform piece (ADR 0035 decision 2).** The error format belongs to every module and none:
`ERROR_CODES` and `errors.ts` sit beside the read-only gate and the rate limiter. A module adds
its codes as rows in that one table (as Storage's are), never a table of its own in
`packages/contracts/src/<module>.ts`, and its routes answer through `apiError`.

**Codes renamed.** Every existing code moved to lower case (`STORAGE_FULL` → `storage_full`,
`BILLING_INACTIVE` → `billing_inactive`, …), as did Storage's `uploadsBlocked`. Nothing read
them, so this is a rename, not an expansion.

## Decision 2: Effect v4 in the Worker, for jobs and internals

The Worker adopts Effect where ADR 0009 put it in the mail service: lifetimes, retries and
failure policy around plain functions. The HTTP surface stays Hono, zod contracts and the typed
Hono client.

Facts the decision rests on (2026-11-16):

- `effect@4.1.4` is the latest release, and the 4.x line is long-term support ("at least three
  years of bug and security fixes", the package README). HTTP and SQL ship in the same package
  as subpaths (`effect/http`, `effect/http-api`, `effect/sql`).
- `HttpApi` and `HttpRouter` are marked `@stability unstable` in that release's source.
- `@effect/sql-drizzle` (0.51) peers on `effect@^3` and `drizzle-orm <0.50`: v3 only. Drizzle's
  own Effect support is in its 1.0 release candidates (`drizzle-orm@1.0.0-rc.5`) and targets
  `pg`, not the postgres-js driver `@omni/db` uses.
- A Worker bundle with Effect's core costs about 39 KB gzip; with `HttpApi` and `Schema`, about
  159 KB.

So:

1. **First targets**, one PR each, landing in each module's `jobs.ts` as ADR 0035 lays them out: the AI queue consumer (`queue.ts`, as ADR 0009 described),
   Storage's crons (`storage-cron.ts`) and Storage's billing job (`storage-billing.ts`).
2. **Shape of each.** Failures are typed errors split into retryable (a Hyperdrive blip, a model
   overload, Stripe's 5xx) and permanent (a row that no longer exists, a malformed job).
   In-invocation retries are a `Schedule` bounded well inside the Worker's limits;
   cross-invocation retries stay with Queues and cron reruns. The per-run database client is an
   `acquireRelease` resource, so it closes however the run ends.
3. **Drizzle stays as it is**, called through `Effect.tryPromise` at the edge. No
   `@effect/sql`, no Drizzle Effect driver.
4. **Rules that still hold.** E2E suites run against the real stack with no Layer test doubles.
   `@omni/mail-core` and `@omni/ai` stay Effect-free. Logging stays on `log.ts`.
5. **Revisit the HTTP surface** when `HttpApi` is marked stable and its schemas interoperate with
   zod through Standard Schema, so the contracts in `@omni/contracts` need not be rewritten.

## Rollout

1. This change: the table, the Worker helper, every Worker error through it, and the clients
   sending the header and reading both shapes.
2. Effect, in the order above, in later PRs.
3. **Contract (a later task): remove the legacy shape** once both hold: the iOS minimum supported
   build sends `omni-error-format: 2` (no release older than that still in use, by Sentry's
   release data), and 30 days
   have passed since the web app that sends it deployed (old tabs reload by then). Then the Worker
   answers the nested shape to everyone, and the header becomes a no-op clients may stop sending.

## Consequences

- Clients can branch on `code` instead of matching messages, and every error a person reports
  carries a request ID.
- A new code is one row in `ERROR_CODES`; its status cannot drift from its category.
- Until the contract step, the Worker answers two shapes, and raw `fetch`/XHR callers that do not
  send the header (the web app's upload XHR, the mail service) get the legacy one.
- Effect adds a second idiom to the Worker, confined to jobs, and about 39 KB gzip to its bundle.

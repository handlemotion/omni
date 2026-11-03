# 0009: Effect at the mail service's edges

Date: 2026-11-03 · Status: accepted

## Context

The mail service (`apps/mail`) is the one long-running process: an IMAP connection per mailbox,
periodic folder syncs, the outbox, and a graceful exit when Fly.io sends SIGTERM. Each module
hand-rolled its own retry loop, sleep-with-wake, interval timers, concurrency limiter and
shutdown ordering. They worked, but each was a slightly different pattern, and the hard cases
(a socket left open when `stop()` lands mid-connect, a timer firing during shutdown, a bug in the
sync code ending a mailbox's reconnect loop) depended on flags checked in the right places.

The spec does not name a library for this. AGENTS.md asks for maintained libraries over our own
code where the product does not differ, and resilience is not where Omni differs.

## Decision

Use [Effect](https://effect.website) v4 (`effect@4.1.2`, stable) in `apps/mail` only, at the
service's edges:

| Concern                               | Before                                       | Now                                                                                                                                        |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Retry and backoff                     | `backoffDelay` + `setTimeout` loops          | `backoff()` in `timing.ts`: a `Schedule` (exponential, full jitter, capped, with a floor). Stop conditions are `Schedule.while`/`upTo`.    |
| IMAP connection lifetime              | `connect`/`onClose`/`stop` flags             | A `session()` with the `ImapFlow` client as an `acquireRelease` resource: any exit (drop, failure, interruption) logs out and closes it.   |
| Per-mailbox reconnect loop            | `connectWithRetry` + `sleep` + `wakeSleeper` | One fiber per mailbox: `session` → `Effect.retry(schedule)` → `Effect.forever`. Defects are retried, so a bug cannot end the loop.         |
| Error classification                  | `authenticationFailed` checks inline         | Typed errors: `ImapAuthFailed`, `ImapConnectFailed`, `ImapDropped`. The outbox keeps `PermanentActionError` / `MailboxUnavailableError`.   |
| Concurrency limit                     | `createLimiter`                              | `Semaphore`; a connect attempt holds a permit only while it connects and runs the first sync.                                              |
| Periodic sync, outbox poll, reconcile | `setInterval`                                | `every()` in `timing.ts`: `Effect.schedule` on `Schedule.fixed` in its own fiber, interrupted on stop. A slow run never overlaps the next. |
| Shutdown on SIGTERM                   | `setTimeout` force-exit + `service.stop()`   | One Effect with `timeoutOption("20 seconds")` (Fly's `kill_timeout` is 30s): stop loops, drain claimed actions, interrupt mailbox fibers.  |
| Config                                | zod                                          | Unchanged: zod at startup, env vars the only source (AGENTS.md).                                                                           |

### Scope boundary: Effect at the edges, plain functions inside

- Effect owns lifetimes, timing and failure policy: when to connect, retry, give up, stop.
- The work itself stays plain `async` code: `syncFolderNow`, `discoverFolders`, the outbox's
  `perform`/`send`, the storage ports, and the HTTP app. Effect wraps them with
  `Effect.tryPromise`; they do not import Effect.
- Public APIs stay Promise-based (`MailboxConnection.start/stop/syncAll/run`,
  `OutboxExecutor.drain`, `Supervisor`, `startService`). Each fiber is started with
  `Effect.runFork` and stopped with `Fiber.interrupt`. No `Layer`/`Context` service graph yet:
  it would rewrite every constructor for no behavior we need today.
- `packages/mail-core` and `packages/ai` stay free of Effect: they are pure functions that test
  cheaply and port anywhere (AGENTS.md). `apps/worker` and `apps/web` do not use Effect.
- Logging stays on `log.ts`'s JSON logger, not Effect's `Logger`, so this change and the
  observability work in `log.ts` do not collide.

### One deliberate behavior change

A rejected login used to retry forever at the 5-minute ceiling. Now, after `maxAuthFailures`
(default 3) rejections in a row, each a full ceiling apart, the connection stops, emits
`gave_up` and logs `imap.gave_up` at error level. The mailbox is already marked `error` on the
first rejection. It reconnects when someone saves a new app password (onboarding's `connect`
removes and re-adds it) or when the process restarts. Three tries over about 10 minutes rides
out a mail host's brief auth outage without logging in with a known-bad password forever.

## Why

- The resilience rules are now declared in one place each (a schedule, a scope, a fiber) instead
  of spread across flags, so the cases that used to need care hold by construction: interrupting
  a mailbox mid-connect or mid-backoff closes its socket, and a stop during the wait between
  retries returns at once.
- Effect 4 is stable, maintained, has no runtime dependencies we lack, and its `Schedule`,
  `Scope` and fiber interruption are exactly the primitives we were re-implementing.
- Keeping it at the edges limits what a reader must learn: the IMAP and outbox logic still reads
  as ordinary TypeScript.

## Costs

- A new dependency and a new idiom in one app. `build.mjs` keeps npm packages external, so
  `effect` ships in the image's `node_modules`: about 56 MB unpacked, of which the service loads
  only the modules it imports. Contributors touching connection lifetimes need to read Effect's
  `Schedule`, `Scope` and `Fiber` docs.
- `Effect.tryPromise` interruption abandons the promise rather than cancelling it. Where that
  matters (a sync in progress on `stop()`), the old cooperative `stopped` flag still does the
  stopping, and `stop()` waits for the command queue before interrupting the fiber.

## Later: the Worker's AI queue consumer

If we adopt Effect in `apps/worker`, the first candidate is `consumeAiQueue` in
`apps/worker/src/queue.ts`, and it would follow the same boundary:

- `runAiJob` and `@omni/ai` stay plain functions. The consumer wraps each message in
  `Effect.tryPromise` and classifies failures as typed errors: retryable (model overloaded or
  rate-limited, Hyperdrive blip) versus permanent (a thread that no longer exists, a malformed
  job).
- In-invocation retries are a `Schedule` bounded well inside the Worker's CPU and wall-clock
  limits. Cross-invocation retries stay with Cloudflare Queues (`message.retry({ delaySeconds })`
  and the DLQ), with the delay computed from the same backoff formula, the way the outbox
  persists `retryAt` here.
- The per-batch database client becomes an `acquireRelease` resource, so `close()` runs however
  the batch ends.
- `Effect.forEach(messages, job, { concurrency })` replaces the serial loop if we want parallel
  jobs within a batch.

That is a separate decision with its own ADR, made when the consumer's error handling grows past
one `try`/`catch`.

# 0050: Production jobs run only when their inputs change

Date: 2026-11-19 · Status: accepted · Amends: ADR 0019 (platform deploys)

## Context

ADR 0019 ran both jobs in `production.yml` on every push to `main`. In the 48 hours to
2026-11-19 that was 84 pushes and 168 jobs, while 4 pushes touched a migration and 3 touched the
Worker's env or config. Every other run migrated nothing and re-uploaded the same secrets. On
GitHub-hosted runners each job is billed in whole minutes, so these runs were about a third of
the repository's Actions minutes, and the secret sync also made a new Worker version each time.

## Decision

1. **Migrations run on a push that adds or edits `packages/db/migrations/`.** The workflow's
   `paths` filter starts a run only for a push that touches either job's inputs, and each job
   diffs from the commit of the last successful Production run to decide whether it has work.
   Not from the push's `before`: concurrency replaces a pending run with a newer one, which must
   still do the replaced run's work. The push event in Actions carries no per-commit file lists.
2. **The Worker secret sync runs on a push that changes `apps/worker/.dev.vars.example` or
   `wrangler.jsonc`** (or the sync's own scripts). A new secret is documented in
   `.dev.vars.example` (AGENTS.md), so code that needs one arrives with that change.
3. **Both run daily (09:23 UTC) and by hand.** Both are idempotent. The daily run picks up a
   Doppler edit made without a code change. Change a
   production secret and want it live now: Actions, Production, Run workflow.
4. The secret sync waits for Cloudflare's build of the commit on every event, not only on push.

## Consequences

- A Doppler-only change to `prd_worker` reaches the Worker within a day, or at once by hand,
  instead of on the next push.
- Most pushes to `main` start no Actions job; the platforms still deploy them.

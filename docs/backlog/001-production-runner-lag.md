# Production migrations wait hours for self-hosted runners while code deploys at once

|          |                                                  |
| -------- | ------------------------------------------------ |
| Severity | high                                             |
| Area     | Ops (.github)                                    |
| Who      | Needs Rodrigo: which runners production jobs use |
| Status   | open                                             |
| Found    | 2026-11-19, read against `main` at `15ffca9`     |

## Files

- `.github/workflows/production.yml:21-23` (one concurrency group), `:32`, `:56` (`runs-on: boat-small`)
- .github/scripts/wait-for-checks.sh:10,22-25

## Problem

Cloudflare Workers Builds and Fly deploy a merge immediately, but `production.yml` (database migrations and the Worker secret sync) runs on the self-hosted `boat-small` runners, which queued 55 min to 2h18m on 2026-11-18. Code that reads a new column ran before the column existed: Sentry OMNI-WORKER-F logged 55 `column mailboxes.label does not exist` errors on `GET /api/mailboxes` (19:34–19:38 UTC) after #486. Migration 0049 (#489) was applied by hand from Rodrigo's Mac. The boat runners were reported stalled since 2026-11-18 18:32 UTC.

## Evidence

- Run 44370860004: migrate queued 18:32 → 19:27.
- Run 44382433109: secrets job queued 19:42 → 22:00.
- 11 of the last 20 production runs were cancelled as superseded; migrations of a new commit queue behind the previous run's secret job (same concurrency group).
- `wait-for-checks.sh` gives up after 180 s without a Cloudflare check and carries on, reopening the race its header describes.

## Fix

1. Split concurrency per job (`production-migrate`, `production-secrets`) so migrations never wait on the secret sync (safe, under 10 lines).
2. Run both jobs on GitHub-hosted `ubuntu-latest`, or on a runner label PR CI can't use (owner decision).
3. Alert when a production job is queued more than 10 minutes.
4. Document the runners in `docs/operations/`.
5. Resolve Sentry OMNI-WORKER-F once migrations are reliable.

## Done when

A merge with a migration shows the `Migrate database` job starting within a few minutes of the merge in the Actions history.

## Notes

Related: [expand-contract-check](023-expand-contract-check.md). The CI thread already asked Rodrigo where the boat runners are managed.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.

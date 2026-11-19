# Nightly Full e2e has failed six nights running, so worker, mail and web e2e give no signal

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | high                                         |
| Area     | CI / packages/client                         |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `.github/workflows/full.yml:14-15,89-93`
- `package.json:22` (`turbo run test:e2e`, no `--continue`)
- `packages/client/e2e/client.e2e.test.ts:116-117`

## Problem

CI (`Checks`) only runs the `@omni/db` e2e suite; worker, mail, web and client e2e run nightly in `Full`. Nov 13–16 the nightly failed in `client.e2e.test.ts` (`organization.list()` expected `[org.id]`, got two orgs, probably the Personal space from ADR 0024), and Turbo stopped every other e2e task. Nov 17–18 it failed starting the stack (S2 on port 8090, fixed by #477; no nightly has confirmed it yet).

## Evidence

- Runs 43445265858, 43600861073, 43722360474, 43902988745: `Failed: @omni/client#test:e2e`, `Tasks: 0 successful, 4 total`.
- Runs 44123296034, 44339951783: S2 could not bind 8090.
- `full.yml` triggers PRs only on `types: [labeled]`, so pushes after adding `full-e2e` don't re-run it.

## Fix

1. Fix the client assertion (expect the list to contain `org.id`, or filter out the Personal space) and run that one file locally.
2. `pnpm test:e2e -- --continue` (or `turbo run test:e2e --continue`) in `full.yml` so one red package doesn't hide the rest.
3. Add `synchronize` to the PR trigger and keep the label check in the job's `if:`.
4. Optional: notify on a failed scheduled run.

## Done when

Trigger `Full` with `workflow_dispatch`; all four e2e tasks run and pass.

## Notes

Root config and CI are shared files; call it out in the PR.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.

# Worker errors in Sentry have minified stack traces

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Ops (apps/worker)                            |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/wrangler.jsonc` (no `upload_source_maps`, no `version_metadata`)
- `apps/worker/src/index.ts:24-33` (`withSentry`, no release)
- `apps/worker/scripts/deploy-cloudflare.mjs:23`
- `docs/self-hosting.md:561-572`

## Problem

Only the web app uploads source maps (`apps/web/vite.config.ts:31-44`). Sentry reports no debug IDs for the Worker bundle, so OMNI-WORKER-* frames point at `index.js:181703`.

## Evidence

Sentry issue OMNI-WORKER-F: "Source maps weren't applied … the project has no debug ID uploads."

## Fix

Add `"upload_source_maps": true` and a `version_metadata` binding; in `deploy-cloudflare.mjs` deploy with `--outdir`, then, when `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` are set, upload with `sentry-cli sourcemaps upload --release=<versionId>`; set those as Workers Builds variables; document in `self-hosting.md`.

## Done when

After a deploy, a new Worker error in Sentry shows TypeScript file names and lines.

## Notes

Setting Workers Builds variables is a dashboard step for Rodrigo.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.

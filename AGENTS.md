# Omni agent rules

Omni is one AI-first inbox, plus Drive and a CRM, over mail hosted at Purelymail (or any
IMAP/SMTP host). The product spec is `docs/spec/`: read the part you touch before you design, and
when a change departs from it, update the spec in the same PR. The code is the record; git
history has the why.

This file holds only what the code can't tell you. An app's or package's own `AGENTS.md` extends
it and wins where they differ. Explicit user instructions override every file here.

## Hard boundaries

- Only `apps/mail` speaks IMAP/SMTP and holds mail passwords, the credential key and the
  Purelymail API token. The Worker never calls Purelymail.
- Routes never query mail tables; every read goes through `db.forMember(memberId)`.
- Every workspace-owned table has `org_id` (user-level tables, Better Auth's and `user_emails`,
  do not). Every background job is idempotent (safe to run twice).
- `packages/mail-core` and `packages/ai` stay free of I/O and UI; `ai` takes its model client.
- Worker ↔ mail service calls are HMAC-signed with a timestamp (`@omni/crypto`); reject anything
  older than the window. Never hand-roll a second signer or verifier.
- Mail, Storage and CRM are modules: `schema/<module>.ts`, a surface file `<module>.ts` over a
  private `<module>/` folder in `@omni/db`, `contracts/src/<module>.ts`,
  `apps/worker/src/<module>/`. A module reads another only through its surface file and only if
  `scripts/check-modules.mjs` lists it in `uses` (enforced).
- Self-hostable: config comes only from environment variables, validated with zod at startup and
  documented in the unit's `.env.example` (Worker: `.dev.vars.example`). Code never calls
  Doppler, and holds no Handlemotion-specific account IDs, domains, buckets or hostnames.
  Purelymail-only features sit behind the mailbox `provider` and are optional. Update
  `docs/self-hosting.md` when you add a required service, binding or variable.
- `apps/web` and `apps/ios` are owned by Rodrigo: no UI work unless asked. For any UI work, read
  `DESIGN.md` first. No explanatory text in the UI (hints, notices, subtitles, helper lines)
  unless the Figma frame or the user asks for that exact text; ask instead.

## Commands

- `pnpm install` · `pnpm format` · `pnpm lint` · `pnpm check-types` · `pnpm fix`
- `pnpm check`: format check, oxlint, and the policy scripts (`scripts/check-*.mjs`).
- `pnpm test`: affected unit suites. `pnpm test:e2e`: e2e suites against the local stack, which
  `pnpm stack:up` starts (Postgres `localhost:54329`, GreenMail IMAP `3143` / SMTP `3025`). One
  file: `pnpm --filter <pkg> test:e2e e2e/<file>`.
- `pnpm stack:serve` serves the real Worker and built web app on `:8787`, detached, once
  `/health` answers; `pnpm stack:serve:stop` stops it. Use it instead of `cmd &`.
- `pnpm ios:dev` runs the iOS dev build in the booted Simulator (`--device` for a plugged-in
  iPhone); details in `apps/ios/README.md`. Keep one Simulator booted, and shut down any
  Simulator, Metro, server or container you started.
- Node 26 (`.nvmrc`). The pre-commit hook formats and lints staged files, so re-read a file after
  committing before editing it again.

## Tests

Each test must catch a bug we would plausibly ship; name it before writing the test.

- Behavior that crosses a process, the database, IMAP/SMTP, auth or HTTP is proven in
  `*.e2e.test.ts` against the real local stack, with no mocks (enforced).
- Unit tests only for pure logic in `packages/mail-core`, `packages/ai`, `packages/crypto` and
  `scripts/` (enforced). No `.only`, `.skip`, `.todo` (enforced). Never weaken an assertion.
- Real emails for tests go in `fixtures/eml/`, anonymized. AI calls in tests use recorded
  fixtures, never a live model from `pnpm test` or CI.
- Before calling work done, run it on the real local stack and report what you ran and saw.

## Secrets (Doppler)

- Doppler project `omni`, configs `dev`, `dev_worker`, `dev_mail`, `prd_worker`, `prd_mail`,
  `prd_github` (`docs/operations/doppler.md`). Run as `doppler run -p omni -c <config> -- <cmd>`.
- Never commit, print, export or persist a credential (`*_SECRET*`, `*_KEY`, `*_TOKEN`,
  `DATABASE_URL`); check it by name, presence or length. Plain config (buckets, endpoints, URLs)
  you may read with `doppler secrets get <NAME> --plain`. Unsure: treat it as a credential.
- Production secrets change only with explicit approval. Do yourself any step the CLIs here
  (`doppler`, `cf`, `flyctl`, `gh`, `docker`) can do; hand off only what needs a human.

## Database

- Schema changes go through `packages/db/src/schema` and `db:generate`. Never hand-write
  migrations, journals or snapshots, and never `drizzle-kit push` or run ad hoc SQL against a
  shared or production database.
- Migrations, the Worker, the mail service and clients deploy independently, in no fixed order.
  Expand, then contract: add the new column, field, route or message and keep reading the old;
  remove the old shape in a later PR once production no longer uses it.
- Postgres is an index the mail host can rebuild: a full re-sync must converge.

## Shipping

- PRs target `main`, squash-merged, with `Checks` green. Titles are Conventional Commits,
  `type(scope): summary` (scope: `ios`, `desktop`, `web`, `worker`, `mail`, `drive`, `crm`,
  `db`); release-please versions the desktop and iOS apps from them
  (`docs/operations/releases.md`). Never hand-edit a version or `CHANGELOG.md`.
- Descriptions follow the `pr-writing` skill; load it before writing one.
- **Stacked work goes through the `gh stack` CLI and the GitHub API, no exceptions.** Work that
  depends on unmerged work, or that runs beside another thread on the same module, is a layer in a
  `gh stack` rooted on `main` (the `gh-stack` skill). Create, push and restack it with `gh stack`;
  open and link its PRs with `gh stack submit` or the REST calls below. Never hand-open a stacked
  PR on `main`, never merge into a branch that is not `main`, and never fall back because "gh
  doesn't work here": it does. In a Claude Code cloud session:
  - `gh auth status` says the token is invalid; ignore it. REST works (`gh api user`), only
    GraphQL is blocked. So `gh stack init`, `add`, `rebase`, `push --remote origin` and `view`
    work; `submit`, `link`, `merge` and `sync`'s PR step need GraphQL and fail there.
  - Layer branches are `<your session branch>-<layer>`. After `gh stack push --remote origin`,
    open each PR with `gh api repos/{owner}/{repo}/pulls -f head=<layer> -f base=<branch below>
    -f title=… -f body=…`, then link them bottom to top:
    `echo '{"pull_requests":[<bottom>,…,<top>]}' | gh api -X POST repos/{owner}/{repo}/stacks
    --input -` (a new top layer: `POST …/stacks/<n>/add`). Check with
    `gh api "repos/{owner}/{repo}/stacks?pull_request=<n>"`.
  - A PR's base is always the next unmerged layer below it, or `main`; never pick one by hand.
    An unlinked chain is not a stack: GitHub won't retarget it, so a child of a merged parent
    merges into a dead branch (#582). When a layer merges, the layers above it must move down:
    `git fetch origin`, `gh stack rebase`, `gh stack push --remote origin`, and on the laptop
    `gh stack sync`; in the cloud set each child's base with
    `gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -f base=<new base>`. Before merging any PR,
    check `gh api repos/{owner}/{repo}/pulls/<n> --jq .base.ref` is `main`; merge stacks only
    with `gh stack merge`.
  - When the layer below changes, `gh stack rebase`, then `gh stack push --remote origin`.
  - A first `gh stack push` that fails with `stale info` means the session's
    `origin/<branch>` ref points at a branch that doesn't exist yet: `git push -u origin <branch>`
    once, then `gh stack push` works.
- Migrations number in stack order: each layer runs `db:generate` on top of the layer below, so a
  layer's migration is always one above the one beneath it. Two threads that both add a migration
  are never parallel: the later one becomes a layer on the earlier one's stack. When a restack
  conflicts in `packages/db/migrations/`, take the lower layer's folder
  (`git checkout <branch below> -- packages/db/migrations`), run `db:generate` again and fix the
  table list in `packages/db/e2e/migrations.e2e.test.ts`.
- Parallel stacks each name the modules they own; two stacks never edit the same module or
  platform file. The upper layer resolves shared files: `pnpm-lock.yaml` (`pnpm install`),
  `schema/index.ts`, `apps/worker/src/app.ts`, `modules.ts`. Don't edit `AGENTS.md`, CI or root
  config unless that is your task. Uncommitted work you don't recognize belongs to someone else.
- Lint caps complexity, nesting and file length. Never add a file to the `.oxlintrc.json` debt
  overrides; remove one when you bring it under the cap.
- Before each push run `pnpm check`, `pnpm check-types`, the affected unit suites and the e2e
  files your change touches. CI runs only the `@omni/db` e2e suite; the rest run nightly in
  `Full`, or on a PR with the `full-e2e` label.
- Before calling a PR done or ready, check it has no conflicts with `main`: `git fetch origin main`
  and `git merge-tree --write-tree HEAD origin/main` (non-zero exit means conflicts), or
  `gh api repos/{owner}/{repo}/pulls/<n> --jq .mergeable` is `true`. If it conflicts, merge `main`
  in (the stack rules above for migrations and shared files) and re-run the checks before saying
  it is done. Check again after each push and each merge to `main` while it is open.
- Merging to `main` deploys: Workers Builds ships the Worker, Fly deploys the mail service,
  `.github/workflows/production.yml` migrates. Never `wrangler deploy` or `flyctl deploy` by
  hand. After a merge, check production: the new version is live, `/health` and changed routes
  answer, logs show no new errors. Ask first before a check that touches production data, sends
  mail or costs money.

## Infrastructure

- Cloudflare account **Handle** (its ID is `CLOUDFLARE_ACCOUNT_ID` in `prd_github`) owns `omnidirectional.app`
  and every Worker, R2 bucket, Queue and Hyperdrive config. Inspect and change it with `cf`
  (token from `doppler run -p omni -c prd_github -- cf ...`); `wrangler` only for local dev and
  type generation.
- The mail service runs on Fly.io, org `handlemotion`. PlanetScale Postgres is the database.
- Repo skills live in `.claude/skills/`, each symlinked from `.agents/skills/`; add new ones in
  both.

# Omni agent rules

Omnidirectional ("Omni") is one AI-first inbox for every domain Handlemotion's projects use.
Purelymail hosts the mail; Omni is the window on top. The product spec is `docs/spec/v1.md`: read
it before you design anything, and record any departure from it as an ADR in `docs/adr/`.

TypeScript monorepo: pnpm workspaces + Turborepo, Cloudflare Workers (Hono), a Node mail service
on Fly.io, Drizzle over PlanetScale Postgres, Better Auth, Anthropic SDK.

Repo-wide rules only. Before editing an app or package, read its `AGENTS.md` if it has one: it
extends this file and wins where they differ. Explicit user instructions override every file here.

## Architecture

| Unit                 | Package           | Role                                                                             |
| -------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `apps/worker`        | `@omni/worker`    | The one Cloudflare Worker: Hono API, AI queue consumer, realtime Durable Object. |
| `apps/mail`          | `@omni/mail`      | Always-on Node service on Fly.io. The only code that speaks IMAP/SMTP.           |
| `packages/db`        | `@omni/db`        | Drizzle schema, migrations, and the only data access path: `db.forMember()`.     |
| `packages/mail-core` | `@omni/mail-core` | Pure functions: threading, reply stripping, sanitizing. No I/O.                  |
| `packages/ai`        | `@omni/ai`        | `triage()` and `summarize()`. Takes a model client; no other I/O.                |
| `packages/crypto`    | `@omni/crypto`    | HMAC request signing and AES-256-GCM credential encryption (Web Crypto).         |
| `packages/auth`      | `@omni/auth`      | Better Auth config (passkeys, magic links, organizations) shared by all clients. |

- Mail, Storage and CRM are **modules** inside `@omni/db`, `@omni/contracts` and `@omni/worker`,
  laid out as ADR 0035 decision 3 says: `schema/<module>.ts`, a surface file `<module>.ts` over a
  private `<module>/` folder, `contracts/src/<module>.ts`, `apps/worker/src/<module>/`. A module
  reads another only through its surface file, and only if `scripts/check-modules.mjs` lists it
  in `uses`; that script enforces the rest in `pnpm check`.
- `apps/web` (Vite SPA) and `apps/ios` (Expo) are owned by Rodrigo. Agents do not create or edit
  UI unless asked; build the API and types those apps will consume.
- Any UI or design work: read `DESIGN.md` first, every time. It routes to the tokens, the
  component folders, and the Figma file, and its rules (components only, semantic classes,
  `skullet` for loading states) apply to every screen.
- **Hard ban on inline context text.** No explanatory sentences, notices, hints, helper lines,
  subtitles or descriptions in the UI unless the Figma frame or the user asks for that exact
  text. A label, a title and the control are enough; when something seems to need explaining,
  ask instead of adding copy.
- Boundaries are hard:
  - Only `apps/mail` holds mail passwords, the credential key, and the Purelymail API token.
    The Worker never talks to Purelymail.
  - Routes never query mail tables directly. Every read goes through `db.forMember(memberId)`.
  - Every table has `org_id`. Every background job is idempotent (safe to run twice).
  - `mail-core` and `ai` stay free of I/O and UI so they test cheaply and port anywhere.
- Worker ↔ mail service calls are HMAC-signed with a timestamp; reject anything older than the
  window. Shared code for this lives in one place; never hand-roll a second verifier.

## Commands

- Install `pnpm install` · Format `pnpm format` · Lint `pnpm lint` · Types `pnpm check-types`
- `pnpm check` runs format check, lint, and policy scripts (`scripts/check-*.mjs`); `pnpm fix`
  applies the fixable ones.
- `pnpm test` runs affected unit suites. `pnpm test:e2e` runs e2e suites; start the local stack
  first with `pnpm stack:up` (Postgres on `localhost:54329`, GreenMail IMAP `3143` / SMTP `3025`).
  E2E files run in parallel, and the Worker is built once per change
  (`apps/worker/e2e/global-setup.ts`); one file: `pnpm --filter <pkg> test:e2e e2e/<file>`.
- `pnpm stack:serve` serves the real Worker and built web app on `:8787` against the local
  database, detached; it returns once `/health` answers (`pnpm stack:serve:stop` stops it). Use it
  for UI checks instead of backgrounding a server yourself (`cmd &` in a piped script hangs).
- `pnpm share` (the Omni stack) or `pnpm share <port>` prints a private HTTPS URL for a server on
  this machine that opens on the user's own devices; send it whenever they should see or use
  what you built. `pnpm share stop` ends it. Setup: `docs/operations/cloud-sessions.md`.
- `pnpm ios:dev` runs the iOS app (an Expo development build, "Omni Dev") in the booted
  Simulator with Metro hot reload; `--device` puts it on a plugged-in iPhone. It rebuilds the
  native app only when `apps/ios/package.json` or `app.config.ts` changed, so later runs take
  seconds. Run it in the background, wait for `Logs for your project`, edit, then check the UI
  with `xcrun simctl io booted screenshot <file>.png`. The API is `EXPO_PUBLIC_OMNI_API_URL`
  (default the local stack's `http://localhost:8787`). One Metro per port: if another thread's
  is up, reuse it (the app reloads on save) or set `OMNI_IOS_METRO_PORT`. Details:
  `apps/ios/README.md`.
- Node is 26 (`.nvmrc`); the mail service needs it. Cloud sessions put `/opt/node/bin` first.
- The pre-commit hook runs `lint-staged` (`oxfmt`, `oxlint --fix`, test policy), so staged files
  can change during `git commit`. Re-read a file after committing before you edit it again.

## Testing

Tests are a cost. Each one must catch a bug we would plausibly ship. Zero low-signal tests.

- **E2E first.** Behavior that crosses a process, the database, IMAP/SMTP, auth, or HTTP is proven
  with Vitest e2e suites (`*.e2e.test.ts`) against the real local stack: real Postgres, real
  GreenMail, real `wrangler`/workerd. No mocks, stubs, or fakes in e2e (enforced).
- **Unit tests only for valuable pure logic**, and only in `packages/mail-core`, `packages/ai`,
  `packages/crypto`, and `scripts/` (enforced by `scripts/check-tests.mjs`). Good: threading against real `.eml`
  fixtures, reply stripping, HMAC/crypto round-trips, triage short-circuits. Bad: testing that a
  constant equals itself, that Drizzle builds a query, that a mock was called, getters, snapshots
  of whole objects nobody reads.
- Before writing a test, name the bug it catches. If you cannot, do not write it.
- Delete tests that stop catching anything. Never weaken an assertion to make it pass.
- Real emails for tests go in `fixtures/eml/` (anonymized). A parser bug becomes a new fixture.
- No `.only`, `.skip`, `.todo` (enforced). AI calls in tests use recorded fixtures or run only
  when `ANTHROPIC_API_KEY` is set and the run is explicitly requested; never from `pnpm test` or CI.
- Evidence is real or reported as unverified. A green suite that mocks the thing under test is
  not evidence.

## Verify it running

Own the follow-through. Green tests are the floor, not the proof.

- Before you call work done, run it: start the real local stack (`pnpm stack:up`, `wrangler dev`,
  the mail service) and exercise the change end to end with real HTTP calls, real IMAP/SMTP, and
  the rows it writes. Report what you ran and what you saw.
- After a merge to `main`, check production yourself: the deploy or build finished, the active
  version is the new one, `/health` (and any route you changed) answers, and logs show no new
  errors (`cf` for Workers, `flyctl` for the mail service, Sentry once wired). Report the
  result, or say exactly what you could not check.
- If a check would touch production data, send mail, or cost money beyond normal use, ask first.

## Secrets (Doppler)

- Doppler project `omni` holds every secret. Configs: `dev` (shared local), `dev_worker`,
  `dev_mail`, `prd_worker`, `prd_mail`, `prd_github`. Details: `docs/operations/doppler.md`.
- Local commands run under Doppler: `doppler run -p omni -c dev_<unit> -- <command>`. Package
  `dev` scripts already do. `DOPPLER_TOKEN` authenticates headlessly (cloud, CI).
- Credentials are keys, tokens, passwords, signing secrets, and connection strings with
  embedded passwords (`*_SECRET*`, `*_KEY`, `*_TOKEN`, `DATABASE_URL`). Never commit, print,
  export, or persist those. Check them by name, presence, or length only.
- Plain config is not a credential: bucket names, endpoints, regions, public URLs, ports, feature
  flags. Read it with `doppler secrets get <NAME> --plain` and verify it instead of guessing or
  asking the user. When unsure which kind a value is, treat it as a credential.
- Writes to `dev*` configs are fine when the user asks. Creating, rotating, or deleting
  production secrets needs explicit approval.
- Do not assign the user a setup or verification step you can do or check yourself with the CLIs
  here (`doppler`, `cf`, `flyctl`, `gh`, `docker`). Hand off only what needs a human: a
  dashboard-only action, a credential you must not see, or approval for production changes.

## Self-hostable by design

Omni is built to be open-sourced and self-hosted (hosted Omni is the product; the code is free).
Every change keeps that path working:

- Config comes only from environment variables, validated with zod at startup, each documented
  in the unit's `.env.example` (Worker: `.dev.vars.example`). Doppler is how _we_ inject them;
  code never calls Doppler, and a plain `.env` must work for anyone else.
- No Handlemotion-specific values in code: account IDs, domains, bucket names, and hostnames are
  config or `wrangler.jsonc` vars with neutral defaults.
- Mail access is provider-agnostic IMAP/SMTP. Purelymail-only features (its admin API) sit behind
  the mailbox `provider` and are optional.
- The local stack (`compose.yml`) plus a user's own Cloudflare account must be enough to run Omni.
  Self-hosting steps live in `docs/self-hosting.md`; update it when you add a required service,
  binding, or variable.

## Database

- Drizzle only. Schema changes go through `packages/db/src/schema` and `db:generate`; never
  hand-write migration, journal, or snapshot files, and never run `drizzle-kit push` or ad hoc SQL
  against a shared or production database.
- Additive schema may land before the code that uses it. Destructive schema (drop, rename,
  nullability tighten) lands only after production code stops using that shape.
- Every change must work next to the previous version of everything it talks to. Migrations, the
  Worker, the mail service and web clients deploy independently and in no fixed order, so a
  merge to `main` briefly runs new code on the old schema, old code on the new schema, and an
  old tab against the new API. Expand, then contract: add the new column, field, route or
  message first and keep reading the old one; remove the old shape in a later PR, once nothing
  in production writes or reads it. Never fix ordering with a deploy procedure.
- Postgres is an index Purelymail can rebuild. Design every sync step so a full re-sync converges.

## Working style

- For multi-step changes, state the goal and acceptance criteria before editing.
- Read the relevant code and the spec section first; follow existing patterns.
- Use maintained libraries for protocols, auth, and parsing (ImapFlow, Nodemailer, mailparser,
  Better Auth, DOMPurify). Write our own code only where the product differs.
- Lint caps cyclomatic complexity at 20, nesting depth at 4, and a source file at 500 lines. Split
  by concern, and model multi-step flows as an explicit state type plus a transition function
  (like `mail-core/src/conversation-status.ts`) instead of growing flags and `if` chains. Files
  that predate the caps are listed as debt in the `.oxlintrc.json` overrides: never add one, and
  remove a file from its list when you bring it under the cap.
- Make the simplest change that meets the ask. Pick the boring, standard path. No compatibility
  layers or fallbacks for code that has never shipped.
- If the premise turns out wrong or the change keeps growing, stop and shrink the plan.
- Before finishing, check the diff against the ask: intent met, relevant checks and tests run,
  nothing unrequested added.

## Shared workspace

Several agents may work in this repository at once.

- Touch only what your task needs. Uncommitted work you don't recognize belongs to someone else.
- One owner per file set. If you need a change in a package another task owns, keep it minimal
  and call it out in your PR.
- Don't edit `AGENTS.md`, CI, or root config unless that is your task; propose the change instead.

## Branching and shipping

- PRs target `main` (or the layer below, in a stack). Squash merge. CI (`Checks`) must be green;
  the `main` ruleset enforces both.
- **PR descriptions follow the `pr-writing` skill, always** (`.claude/skills/pr-writing`): the
  AI-agent first line, problem first, evidence beside every claim, an ELI5. Load it before
  opening a pull request or writing or updating its description.
- **Stacks (`gh stack`, see the `gh-stack` skill).** Work that depends on unmerged work is a
  layer stacked on that branch, never a parallel branch off `main` that copies or re-implements
  it. Each layer is one reviewable PR with one owner. Stacks merge bottom-first.
- **Every layer merges into `main`.** A stack is rooted on `main` and created with `gh stack` or
  the stacks API, so each layer lands on `main` in turn. Never point a PR's base at another
  feature branch outside such a stack, and never merge a PR into a branch that is not `main`:
  work merged into a branch that will become a single PR later has not landed.
- **Parallel agents.** Independent work gets its own stack rooted on `main`. Before starting, an
  agent names the modules it owns (a module is its folders in every package, ADR 0035); two
  stacks never edit the same module or the same platform file. Shared touch points are resolved
  by the later layer: `pnpm-lock.yaml` (merge `main`, run `pnpm install`), root config,
  `docs/self-hosting.md`, `packages/db/migrations/` (delete your own migration, merge `main`, run
  `db:generate` again; never hand-merge the journal or a snapshot), `schema/index.ts`,
  `apps/worker/src/app.ts` and `modules.ts`.
- Before each push run `pnpm check`, `pnpm check-types`, and the tests your change touches: the
  affected unit suites and the e2e files that cover it (one file, or `-t` one test). Batch fixes
  into one push; CI minutes cost money.
- **CI is a light check; the e2e that covers your change is yours to run.** `Checks` (required)
  runs format, lint, policies, gitleaks, types, unit tests and only the `@omni/db` e2e suite.
  Worker, mail, web and client e2e run nightly on `main` in the `Full` workflow, or on a PR when
  you add the `full-e2e` label (do that for risky cross-cutting changes). So run the e2e files
  your change touches locally before pushing, scoped and short (one package, one file, one
  test). Chasing a flake means looping the one failing test, not the suite. Only PRs into `main`
  run CI: a stacked layer runs once it is retargeted to `main` and pushed.
- Deploys happen when `main` changes: Cloudflare Workers Builds ships the Worker, Fly's GitHub
  deploy the mail service, and `.github/workflows/production.yml` migrates and syncs Worker
  secrets (ADR 0019). Never `wrangler deploy` or `flyctl deploy` from a laptop for production.

## Infrastructure

- Cloudflare account **Handle** (`473fbe436e39d8f3d33b6bb09afd3dd7`) owns `omnidirectional.app`
  and every Worker, R2 bucket, Queue, and Hyperdrive config. Use the `cf` CLI (Cloudflare's CLI,
  not `wrangler`) for inspecting and changing account resources, DNS records included, with the
  token from `doppler run -p omni -c prd_github -- cf ...`; `wrangler` only for local dev and type
  generation.
- Mail service runs on Fly.io, org `handlemotion` (ADR 0004). PlanetScale Postgres is the database.
- Research libraries from primary sources first (Context7, Firecrawl developer index, docs).

## Skills

Repo skills live in `.claude/skills/` as real folders, each symlinked from `.agents/skills/` so
other agents find them too. Add a new skill in both places.

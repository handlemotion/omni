# Omni agent rules

Omnidirectional ("Omni") is one AI-first inbox for every domain Handlemotion's projects use.
Purelymail hosts the mail; Omni is the window on top. The product spec is `docs/spec/v1.md`: read
it before you design anything, and record any departure from it as an ADR in `docs/adr/`.

TypeScript monorepo: pnpm workspaces + Turborepo, Cloudflare Workers (Hono), a Node mail service
on Railway, Drizzle over PlanetScale Postgres, Better Auth, Anthropic SDK.

Repo-wide rules only. Before editing an app or package, read its `AGENTS.md` if it has one: it
extends this file and wins where they differ. Explicit user instructions override every file here.

## Architecture

| Unit                 | Package           | Role                                                                             |
| -------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `apps/worker`        | `@omni/worker`    | The one Cloudflare Worker: Hono API, AI queue consumer, realtime Durable Object. |
| `apps/mail`          | `@omni/mail`      | Always-on Node service on Railway. The only code that speaks IMAP/SMTP.          |
| `packages/db`        | `@omni/db`        | Drizzle schema, migrations, and the only data access path: `db.forMember()`.     |
| `packages/mail-core` | `@omni/mail-core` | Pure functions: threading, reply stripping, sanitizing. No I/O.                  |
| `packages/ai`        | `@omni/ai`        | `triage()` and `summarize()`. Takes a model client; no other I/O.                |
| `packages/crypto`    | `@omni/crypto`    | HMAC request signing and AES-256-GCM credential encryption (Web Crypto).         |
| `packages/auth`      | `@omni/auth`      | Better Auth config (passkeys, magic links, organizations) shared by all clients. |

- `apps/web` (Vite SPA) and `apps/ios` (Expo) are owned by Rodrigo. Agents do not create or edit
  UI unless asked; build the API and types those apps will consume.
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

## Secrets (Doppler)

- Doppler project `omni` holds every secret. Configs: `dev` (shared local), `dev_worker`,
  `dev_mail`, `prd_worker`, `prd_mail`, `prd_github`. Details: `docs/operations/doppler.md`.
- Local commands run under Doppler: `doppler run -p omni -c dev_<unit> -- <command>`. Package
  `dev` scripts already do. `DOPPLER_TOKEN` authenticates headlessly (cloud, CI).
- Never commit, print, export, or persist secret values, tokens, or raw DB URLs. Check a secret
  by name or presence only (`doppler secrets --only-names`).
- Creating, rotating, or deleting production secrets needs explicit approval.

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
- Postgres is an index Purelymail can rebuild. Design every sync step so a full re-sync converges.

## Working style

- For multi-step changes, state the goal and acceptance criteria before editing.
- Read the relevant code and the spec section first; follow existing patterns.
- Use maintained libraries for protocols, auth, and parsing (ImapFlow, Nodemailer, mailparser,
  Better Auth, DOMPurify). Write our own code only where the product differs.
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

- PRs target `main`. Squash merge. CI (`Checks`) must be green.
- Before each push run `pnpm check`, `pnpm check-types`, and the affected tests (unit and e2e).
  Batch fixes into one push; CI minutes cost money.
- Deploys happen from `main` through CI only. Never `wrangler deploy` or `railway up` from a
  laptop for production.

## Infrastructure

- Cloudflare account **Handle** (`473fbe436e39d8f3d33b6bb09afd3dd7`) owns `omnidirectional.app`
  and every Worker, R2 bucket, Queue, and Hyperdrive config. Use the `cf` CLI for inspection;
  `wrangler` for local dev and type generation.
- Mail service runs on Railway (ADR 0001). PlanetScale Postgres is the database.
- Research libraries from primary sources first (Context7, Firecrawl developer index, docs).

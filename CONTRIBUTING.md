# Contributing to Omni

Thanks for helping. Omni is one AI-first inbox, plus Drive and a CRM, over any IMAP/SMTP mail
host. This file is the short version; [`AGENTS.md`](AGENTS.md) holds the full rules (written for
coding agents, and they apply to people too), and [`docs/spec/`](docs/spec/) is the product spec.

## Run it locally

You need Node 26 (`.nvmrc`), pnpm and Docker.

```bash
pnpm install
pnpm stack:up     # Postgres, GreenMail (IMAP/SMTP), an S3-compatible store and s2-lite
pnpm dev:stack    # migrates, seeds, and serves the app at http://localhost:5173
```

Sign in as `dev@example.com`. Without the Doppler CLI, `dev:stack` writes each unit's env file
from its `.env.example` (`.dev.vars.example` for the Worker) with fresh local secrets. Edit those
files to turn on optional features such as AI triage (`ANTHROPIC_API_KEY`). To run Omni for real,
see [`docs/self-hosting.md`](docs/self-hosting.md).

## Before you open a pull request

- `pnpm check` (format, lint and the policy scripts) and `pnpm check-types`.
- `pnpm test` for the unit suites you touched, and `pnpm --filter <pkg> test:e2e e2e/<file>` for
  the e2e files your change touches, against the local stack.
- Tests prove behavior that crosses the database, IMAP/SMTP, auth or HTTP end to end, with no
  mocks; unit tests are only for pure logic. Each test should catch a bug we could plausibly ship.
- Schema changes go through `packages/db/src/schema` and `pnpm --filter @omni/db db:generate`;
  never hand-write migrations.
- If your change departs from `docs/spec/`, update the spec in the same pull request.

## Pull requests

- Titles are [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, with scope one of `ios`, `desktop`, `web`, `worker`, `mail`, `drive`,
  `crm`, `db`. Releases are versioned from them, so don't edit versions or `CHANGELOG.md`.
- Show that it works: the command you ran and its output, before and after screenshots for UI,
  the failing test for a bug fix.
- For UI changes in `apps/web` or `apps/ios`, open an issue first: the design follows a Figma file
  and [`DESIGN.md`](DESIGN.md), and the maintainers decide on new screens and copy.
- Keep pull requests small and focused; we squash-merge them into `main`.

## Security

Never report a vulnerability in a public issue or pull request. See [`SECURITY.md`](SECURITY.md).

## License

Omni is under the [GNU AGPL v3.0](LICENSE). By contributing, you agree that your contribution is
licensed under the same terms.

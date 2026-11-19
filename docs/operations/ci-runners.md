# CI runners

Every job in `.github/workflows` runs on GitHub-hosted runners, paid from the GitHub Enterprise
Cloud plan's included usage. No job depends on a machine of ours being on, and no job reads a
`RUNNER_*` repository variable any more.

| Job                                                        | Runner                     | When it runs                                  |
| ---------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| `Checks` (ci.yml)                                          | `ubuntu-latest`            | Every pull request into main, merge queue     |
| `Warm pnpm cache` (ci.yml)                                 | `ubuntu-latest`            | A push to main that changes the lockfile      |
| `Full` (full.yml)                                          | `ubuntu-latest`            | Nightly if main moved, by hand, `full-e2e`    |
| `Migrate database`, `Sync Worker secrets` (production.yml) | `ubuntu-latest`            | A merge to main that needs them (ADR 0050)    |
| `Rust (Linux)` (desktop.yml)                               | `ubuntu-latest`            | Changes to the desktop app or contracts       |
| Desktop builds (desktop.yml)                               | `macos-15`, `windows-2025` | By hand; Windows also on a `desktop-v*` tag   |
| `Release PR` (release.yml)                                 | `ubuntu-latest`            | Every push to main (seconds)                  |
| `Desktop release` (desktop-release.yml)                    | `macos-15`                 | A merged release PR that raises desktop       |
| `iOS release` (ios-release.yml)                            | `macos-26`                 | A merged release PR that raises iOS           |
| `PR title` (pr-title.yml)                                  | `ubuntu-latest`            | Every pull request into main (seconds)        |
| `Container scan (mail)`                                    | `ubuntu-latest`            | Weekly, or a pull request changing Dockerfile |

## Cost

The plan's included usage is billed in dollars: Linux $0.006, Windows $0.010 and macOS $0.062 a
minute, so a macOS minute costs about ten Linux ones. Builds for macOS and Windows therefore run
only for a release (docs/operations/releases.md). Everything else is Linux.

## Keeping `Checks` fast

`ubuntu-latest` for a private repository has 2 vCPU and 8 GB. `Checks` stays near two minutes
because:

- `setup-node` restores the pnpm store, keyed on `pnpm-lock.yaml`. Caches saved on a pull request
  are visible only to that pull request, and `Checks` never runs on main, so `Warm pnpm cache`
  saves the store from main whenever the lockfile changes. Every pull request then starts from it.
- Postgres starts in the background while dependencies install.
- Docs-only pull requests skip types, unit tests and the db e2e suite.
- `Rust (Linux)` uses `Swatinem/rust-cache`, saved from main by the same workflow's push run.

The slowest step is the `@omni/db` e2e suite (about 70s, two thirds of it importing modules once
per test file).

## Jobs assume a fresh machine

Every GitHub-hosted job gets a new virtual machine, so jobs start the compose stack without
tearing down an old one first, and nothing persists between jobs except the Actions cache.

## Self-hosted runners

None are used. Any runner registered for this repository or its organization (the old `boat`
runners, a Windows PC, its WSL2 Ubuntu, a Mac) can be removed under Settings, Actions, Runners,
and the old `RUNNER_LIGHT`, `RUNNER_HEAVY`, `RUNNER_PRODUCTION`, `RUNNER_WINDOWS` and
`RUNNER_MACOS` variables deleted under Settings, Secrets and variables, Actions. Nothing reads
them.

## Security

The repository is private, so only collaborators' pull requests run. Keep "Run workflows from fork
pull requests" off (Settings, Actions, General).

# CI runners

Every job in `.github/workflows` runs on standard GitHub-hosted runners, which are free for a
public repository. No job depends on a machine of ours being on, and no job reads a
`RUNNER_*` repository variable any more.

| Job                                                        | Runner                     | When it runs                                  |
| ---------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| `Checks` (ci.yml)                                          | `ubuntu-latest`            | Every pull request into main, merge queue     |
| `Warm pnpm cache` (ci.yml)                                 | `ubuntu-latest`            | A push to main that changes the lockfile      |
| `Full` (full.yml)                                          | `ubuntu-latest`            | Nightly if main moved, by hand, `full-e2e`    |
| `Migrate database`, `Sync Worker secrets` (production.yml) | `ubuntu-latest`            | A merge to main that needs them               |
| `Rust (Linux)` (desktop.yml)                               | `ubuntu-latest`            | Changes to the desktop app or contracts       |
| Desktop builds (desktop.yml)                               | `macos-26`, `windows-2025` | By hand                                       |
| `Release PR` (release.yml)                                 | `ubuntu-latest`            | Every push to main (seconds)                  |
| `Desktop release` (desktop-release.yml)                    | `macos-26`                 | A merged release PR that raises desktop       |
| `iOS release` (ios-release.yml)                            | `macos-26`                 | A merged release PR that raises iOS           |
| `PR title` (pr-title.yml)                                  | `ubuntu-latest`            | Every pull request into main (seconds)        |
| `Container scan (mail)`                                    | `ubuntu-latest`            | Weekly, or a pull request changing Dockerfile |

## Cost

Standard runners cost nothing on a public repository. Larger runners would be billed, so no job
uses one. Builds for macOS and Windows still run only for a release or by hand
(docs/operations/releases.md), because they are the slowest jobs.

## Keeping `Checks` fast

`ubuntu-latest` for a public repository has 4 vCPU and 16 GB. `Checks` stays near two minutes
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

None are used, and none should be: on a public repository a fork's pull request could run code on
them.

## Security

The repository is public. Fork pull requests run `Checks` with no secrets and a read-only token,
and only after a maintainer approves them: keep "Require approval for all external contributors"
on and "Send secrets to workflows from fork pull requests" off (Settings, Actions, General).
Secrets live only in the `production` environment, whose jobs never run on a pull request; limit
its deployment branches to `main` and the `desktop-v*` and `ios-v*` tags.

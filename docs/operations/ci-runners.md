# CI runners

Every job in `.github/workflows` picks its runner from a repository variable and falls back to
the `boat` runners when the variable is unset. Nothing changes until a variable is set, and
deleting the variable switches a job straight back.

| Variable            | Jobs                                                        | Unset means    |
| ------------------- | ----------------------------------------------------------- | -------------- |
| `RUNNER_LIGHT`      | `Checks` (ci.yml), `Container scan (mail)`                  | `boat-small`   |
| `RUNNER_HEAVY`      | `Full` (nightly e2e), `Rust (Linux)` (desktop.yml)          | `boat`         |
| `RUNNER_PRODUCTION` | `Migrate database`, `Sync Worker secrets` (production.yml)  | `boat-small`   |
| `RUNNER_WINDOWS`    | Windows leg of the hand-started desktop build (desktop.yml) | `windows-2025` |
| `RUNNER_MACOS`      | macOS leg of the hand-started desktop build (desktop.yml)   | `macos-15`     |

Each value is JSON, read with `fromJSON`: a quoted label (`"boat"`, `"ubuntu-latest"`) or a list
of labels the runner must all carry (`["self-hosted", "omni-linux"]`). Set them under Settings,
Secrets and variables, Actions, Variables, or with
`gh variable set RUNNER_HEAVY --body '["self-hosted","omni-linux"]'`.

## What the jobs assume

The Linux jobs are bash scripts for an x64 Linux machine with Docker. A Windows runner cannot
run them as they are:

- `run:` steps default to PowerShell on Windows; every script here is bash.
- `docker compose` starts Linux images (Postgres, GreenMail, versitygw, s2) on fixed host ports:
  54329, 3025, 3143, 3465, 3993, 8080, 7070, 54380, and 8787 for the Worker. Avoid 8090, which
  the boat image already uses.
- Gitleaks is downloaded as `linux_x64` and checked with `sha256sum`.
- `Rust (Linux)` installs WebKitGTK with `sudo apt-get`, so it needs Ubuntu and passwordless sudo
  (or those packages installed once by hand).
- Compose fixes container names (`omni-postgres`, ...), so one machine runs one job at a time.
  The runner does that by default; do not register two runners on one machine.

So on Windows, run the Linux runner inside WSL2 (Ubuntu). Only the Windows desktop build needs a
native Windows runner.

Boat gives every job a fresh machine. A home machine keeps containers, volumes and the workspace
between jobs, so `Checks` and `Full` run `docker compose down -v` before they start the stack and
again when they finish, even after a failure.

## Bringing the runners online

1. Install WSL2 with Ubuntu 24.04. In `/etc/wsl.conf` set `[boot]` `systemd=true`, so the runner
   can run as a service. In `%UserProfile%\.wslconfig` give WSL at least 8 GB (`[wsl2]`
   `memory=8GB`) and stop it shutting down when idle (`vmIdleTimeout=-1`). Turn off sleep on the
   PC.
2. In Ubuntu, install Docker Engine (or Docker Desktop with WSL integration for this distro), add
   the user to the `docker` group, and allow passwordless sudo for `apt-get`. Install `git`,
   `curl`, `jq` and `unzip`. Node and pnpm come from the workflows' setup actions.
3. Add a runner: repository Settings, Actions, Runners, New self-hosted runner, Linux x64. Run its
   `config.sh` inside Ubuntu with `--labels omni-linux`, then `sudo ./svc.sh install && sudo
   ./svc.sh start`.
4. Check it shows as Idle, then set `RUNNER_HEAVY` to `["self-hosted","omni-linux"]` and start
   `Full` by hand (Actions, Full, Run workflow). When it is green, set `RUNNER_LIGHT` the same way
   and open a small PR to see `Checks` pass on it.
5. For the Windows desktop build: install Rust (MSVC), the Visual Studio C++ build tools,
   WebView2 and Git for Windows, register a second runner natively on Windows with
   `--labels omni-windows`, and set `RUNNER_WINDOWS` to `["self-hosted","omni-windows"]`.
6. Prune now and then: `docker system prune -af --volumes` and the runner's `_work` folder.

## A Mac runner

A Mac fits the macOS desktop build (Tauri plus the File Provider Swift tests), which no Linux or
Windows machine can do. Keep the Linux jobs (`Checks`, `Full`) off it: they download `linux_x64`
binaries and use `apt-get`, and Docker on macOS runs them in a VM that competes with your own work.

A runner takes one job at a time, so it costs only while a job runs: the hand-started desktop
build compiles Rust for roughly 10 to 20 minutes and uses every core while it does.

1. Create a standard macOS user just for CI (`omni-ci`), so jobs never see your files, keychain or
   sign-ins, and install Xcode, Rust and Git for that user.
2. As that user, unpack the runner in its home folder (`~/actions-runner`), never inside your
   `omni` checkout, and register it with `--labels omni-macos`. Its jobs check out into
   `~/actions-runner/_work`.
3. Install it as a service (`./svc.sh install && ./svc.sh start`). Register one runner only, so
   jobs never run in parallel. To keep it out of your way, start it at background priority:
   `taskpolicy -b ./run.sh` instead of the service, or pause it from the Runners page while you
   need the machine.
4. Set `RUNNER_MACOS` to `["self-hosted","omni-macos"]` and start the Desktop workflow by hand.

## Production jobs

Leave `RUNNER_PRODUCTION` off a home PC. Those jobs read production secrets, and when the PC is
asleep migrations wait while Cloudflare and Fly deploy the new code at once (the lag in
`docs/backlog/001-production-runner-lag.md`). Point it at an always-on runner, such as
`"ubuntu-latest"` once GitHub-hosted Linux runners are enabled for the repository.

## Security

The repository is private, so only collaborators' pull requests run. Keep "Run workflows from fork
pull requests" off (Settings, Actions, General), and never make the repository public with a
self-hosted runner attached: any pull request could then run code on the PC.

#!/bin/bash
# SessionStart hook: brings up Omni's local stack in Claude Code cloud sessions. A no-op anywhere
# else (Claude Code sets CLAUDE_CODE_REMOTE=true only in cloud sessions).
#
# Machine tools come from scripts/cloud/setup.sh (the environment's cached setup script). Each
# session this hook puts Node (.nvmrc) on PATH, starts dockerd, installs deps, starts the compose stack,
# writes local env files from Doppler when tokens are set, and migrates the local database.
# Everything is idempotent, so `resume` and `compact` re-runs are cheap. Secret values are written
# to gitignored files only, never printed. See docs/operations/cloud-sessions.md.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
log=/tmp/omni-session-start.log
: >"$log"
trap 'echo "omni: session start failed; see $log" >&2' ERR

# Node from .nvmrc and pnpm from `packageManager`, both in /opt/node/bin. An environment whose
# setup script is not scripts/cloud/setup.sh (or an old copy of it) lacks them, and the image's
# own Node is too old for the mail service: run the setup script here instead (idempotent, ~20 s).
node_bin=/opt/node/bin
if [ "$("$node_bin/node" --version 2>/dev/null)" != "v$(cat .nvmrc)" ] || [ ! -x "$node_bin/pnpm" ]; then
  echo "omni: Node $(cat .nvmrc) or pnpm missing from $node_bin; running scripts/cloud/setup.sh" >&2
  bash scripts/cloud/setup.sh >>"$log" 2>&1
fi
export PATH="$node_bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ] && ! grep -qs "$node_bin" "$CLAUDE_ENV_FILE"; then
  echo "export PATH=\"$node_bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi

if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

pnpm install --frozen-lockfile >>"$log" 2>&1
pnpm stack:up >>"$log" 2>&1

# write_env <token> <target> <example>: the token's Doppler config, layered over the unit's
# example file (Doppler wins). Rewrites only files this hook wrote, never a hand-made one.
marker="# Written by .claude/hooks/cloud-session-start.sh from Doppler; rewritten each session."
write_env() {
  local token=$1 target=$2 example=$3 secrets keys
  [ -n "$token" ] || return 1
  if [ -e "$target" ] && ! head -1 "$target" | grep -qxF "$marker"; then return 0; fi
  if ! secrets="$(DOPPLER_TOKEN="$token" doppler secrets download --no-file --format env 2>>"$log")"; then
    echo "omni: Doppler download for $target failed (see $log)" >&2
    return 1
  fi
  keys="$(printf '%s\n' "$secrets" | cut -d= -f1 | paste -sd'|' -)"
  (
    umask 077
    {
      echo "$marker"
      grep -vE "^(${keys})=" "$example" || true
      printf '%s\n' "$secrets"
    } >"$target"
  )
}

# One read-only service token per Doppler config, like deploy.yml: DOPPLER_TOKEN (`dev`),
# DOPPLER_TOKEN_MAIL (`dev_mail`), DOPPLER_TOKEN_WORKER (`dev_worker`).
write_env "${DOPPLER_TOKEN:-}" packages/db/.env packages/db/.env.example ||
  [ -e packages/db/.env ] || cp packages/db/.env.example packages/db/.env
write_env "${DOPPLER_TOKEN_MAIL:-}" apps/mail/.env apps/mail/.env.example || true
write_env "${DOPPLER_TOKEN_WORKER:-}" apps/worker/.dev.vars apps/worker/.dev.vars.example || true

pnpm --filter @omni/db db:migrate >>"$log" 2>&1

echo "omni: local stack up (Postgres :54329, GreenMail IMAP :3143 SMTP :3025, S3 :7070), db migrated. Log: $log"

#!/usr/bin/env bash
# Waits until Cloudflare's own check runs on a commit (Workers Builds posts one per Worker) have
# finished, so the Worker secret sync runs against this commit's deploy. Only Cloudflare's: Fly's
# GitHub check can stay "in_progress" long after its release is live, and the sync doesn't need it.
# Gives up waiting for one to appear after APPEAR_SECONDS (a push its build watch paths skip gets
# none) and fails after FINISH_SECONDS. Logs each check's name and app.
#   wait-for-checks.sh <sha>     needs GH_TOKEN and GITHUB_REPOSITORY
set -euo pipefail
sha="${1:?commit sha}"
appear="${APPEAR_SECONDS:-180}"
finish="${FINISH_SECONDS:-1200}"
start=$(date +%s)

while :; do
  runs="$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.app.slug == "cloudflare-workers-and-pages") | {name, app: .app.slug, status, conclusion}]')"
  elapsed=$(($(date +%s) - start))
  total="$(jq length <<<"$runs")"
  pending="$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")"
  if [ "$total" -eq 0 ] && [ "$elapsed" -ge "$appear" ]; then
    echo "No platform check run on $sha after ${appear}s; going on."
    exit 0
  fi
  if [ "$total" -gt 0 ] && [ "$pending" -eq 0 ]; then
    jq -r '.[] | "\(.app) / \(.name): \(.conclusion)"' <<<"$runs"
    exit 0
  fi
  if [ "$elapsed" -ge "$finish" ]; then
    echo "Platform checks still running after ${finish}s:" >&2
    jq -r '.[] | "\(.app) / \(.name): \(.status)"' <<<"$runs" >&2
    exit 1
  fi
  sleep 15
done

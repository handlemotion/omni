#!/usr/bin/env bash
# Prints the commit of the last successful Production run on main that this checkout has, or
# nothing (so the caller runs everything) when there is none or the API fails. Diffing from it,
# not from the push's `before`, keeps work from a pending run that concurrency replaced.
#   last-production-sha.sh     needs GH_TOKEN and GITHUB_REPOSITORY
set -uo pipefail
sha="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/production.yml/runs?branch=main&status=success&per_page=1" \
  --jq '.workflow_runs[0].head_sha // empty' 2>/dev/null)" || exit 0
if [ -n "$sha" ] && git cat-file -e "$sha^{commit}" 2>/dev/null; then echo "$sha"; fi

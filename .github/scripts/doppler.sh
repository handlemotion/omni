#!/usr/bin/env bash
# Reads the Doppler config that $DOPPLER_TOKEN (a service token scoped to one config) grants.
# Never prints values except in the format a caller pipes onward.
#   doppler.sh mask           ::add-mask:: every value (run unpiped, first, in each step)
#   doppler.sh get NAME       one value
#   doppler.sh env            NAME=VALUE lines (for `flyctl secrets import`)
#   doppler.sh json           {"NAME": "VALUE"} (for `wrangler deploy --secrets-file`)
#   doppler.sh vars PREFIX    NAME:VALUE lines for keys starting with PREFIX, prefix removed
# Doppler's own DOPPLER_* metadata keys are always left out.
set -euo pipefail
: "${DOPPLER_TOKEN:?DOPPLER_TOKEN is not set}"

secrets="$(curl -fsS -H "Authorization: Bearer $DOPPLER_TOKEN" \
  "https://api.doppler.com/v3/configs/config/secrets/download?format=json")"
own() { jq 'with_entries(select(.key | startswith("DOPPLER_") | not))' <<<"$secrets"; }

case "${1:-}" in
  mask) own | jq -r 'with_entries(select(.key | startswith("WORKER_VAR_") | not)) | .[] | select(. != "") | split("\n")[] | select(. != "") | "::add-mask::" + .' ;;
  get) own | jq -er --arg k "${2:?name}" '.[$k] // error("\($k) is not set in this config")' ;;
  env) own | jq -r 'to_entries[] | "\(.key)=\(.value)"' ;;
  json) own ;;
  vars)
    own | jq -r --arg p "${2:?prefix}" \
      'to_entries[] | select(.key | startswith($p)) | "\(.key | ltrimstr($p)):\(.value)"'
    ;;
  *)
    echo "usage: doppler.sh mask|get NAME|env|json|vars PREFIX" >&2
    exit 2
    ;;
esac

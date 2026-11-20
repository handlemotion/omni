#!/usr/bin/env bash
# Runs every `omni-sync-bench` scenario against the stack `apps/worker/e2e/sync-bench-stack.ts`
# serves, one process each, and prints one JSON line per scenario with the requests it made.
#
#   bench/run.sh <sync-bench.json> [work dir]
#
# The work dir (default a temp dir) keeps the test files between runs: a 2 GiB file to hash, a
# 1 GiB file to upload, and a burst folder (200 files of 2 MiB and 6 of 128 MiB).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
answer="${1:?usage: bench/run.sh <sync-bench.json> [work dir]}"
work="${2:-$(mktemp -d)}"
mkdir -p "$work/burst"

field() { /usr/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$answer" "$1"; }
export OMNI_BENCH_ORIGIN="$(field origin)" OMNI_BENCH_TOKEN="$(field token)" OMNI_BENCH_ORG="$(field orgId)"

fill() { [[ -f "$1" ]] || dd if=/dev/urandom of="$1" bs=1m count="$2" 2>/dev/null; }
fill "$work/2g.bin" 2048
fill "$work/1g.bin" 1024
for i in $(seq 1 200); do fill "$work/burst/small-$i.bin" 2; done
for i in $(seq 1 6); do fill "$work/burst/large-$i.bin" 128; done

swift build --package-path "$here" -c release --product OmniSyncBench >/dev/null
bench="$(swift build --package-path "$here" -c release --show-bin-path)/OmniSyncBench"

rtt() { curl -s "$OMNI_BENCH_ORIGIN/__bench/rtt/$1" >/dev/null; }
run() {
  curl -s "$OMNI_BENCH_ORIGIN/__bench/requests" >/dev/null
  local result
  result="$("$bench" "$@")"
  echo "$result" | /usr/bin/python3 -c '
import json, sys, urllib.request
line = json.loads(sys.stdin.read())
line["rttMs"] = int(sys.argv[2])
line["requests"] = json.load(urllib.request.urlopen(sys.argv[1] + "/__bench/requests"))
print(json.dumps(line, sort_keys=True))' "$OMNI_BENCH_ORIGIN" "${RTT:-0}"
}

RTT=0
run items 20000
for RTT in 0 40; do
  rtt "$RTT"
  run walk
  run list
done
RTT=0
rtt 0
run hash "$work/2g.bin"
run upload "$work/1g.bin"
run burst "$work/burst"

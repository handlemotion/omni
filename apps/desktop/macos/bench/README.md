# omni-sync-bench

What the File Provider engine (`Sources/OmniSyncEngine`) costs in memory and time, measured by
running its own code (the enumerators, the items, the uploader) in a plain process against the
real Worker. Peak memory is the process's lifetime peak physical footprint, the figure macOS
uses to kill an extension that grows too large. Nothing here ships.

On a Mac with the repo's Postgres up (`pnpm stack:up`):

```sh
# 1. The server: a fresh database, a workspace whose owner has 12,000 files in 40 folders,
#    a sync token, and a counting proxy on :8790. Leave it running.
DATABASE_URL=postgres://postgres:postgres@localhost:54329/omni \
  node apps/worker/e2e/sync-bench-stack.ts

# 2. Every scenario, one JSON line each (it writes ~3.9 GiB of test files to the work dir).
apps/desktop/macos/bench/run.sh sync-bench.json /tmp/omni-bench
```

`BENCH_FILES` and `BENCH_FOLDERS` size the tree. `walk` and `list` run twice, the second time
with 40 ms added to every request, as a real network would. Each line carries the requests the
scenario made, by route.

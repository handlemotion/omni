# Search scenarios

`threads.json` holds invented email threads (every name and domain is made up), a fixed `now`,
and queries a person might type, each with the thread they are after (`best`).

`recordings/<query>.json` holds the exact Jev relevance request for that query over every thread
(newest first) and Jev's live response. They are used two ways:

- `packages/ai/src/search.test.ts` checks that today's code still builds the recorded request and
  that the recorded answers put `best` first.
- `apps/worker/e2e/search.e2e.test.ts` seeds the threads into Postgres and answers the Worker's
  relevance questions with the recorded Nouls, matched by query and thread subject.

Re-record after changing the wording, the state, or a fixture (a fraction of a cent). The run
also reports how often `best` comes first, against newest-first order:

```bash
pnpm --filter @omni/ai record:search   # runs under Doppler; or set TYPESAFE_API_KEY and run node eval/record-search.ts
```

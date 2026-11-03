# Triage scenarios

`threads.json` lists email threads built from `fixtures/eml/triage-*.eml`, oldest message first,
with the lane each message should leave the thread in once it arrives. The reader (the inbox
owner) is `reader`; every name and domain is invented.

`recordings/<thread>-<n>.json` holds the exact Jev request built for the thread up to message `n`
and Jev's live response to it. They are used three ways:

- `packages/ai/src/fixtures.test.ts` checks that today's code still builds the recorded request
  and that the recorded answers land in the expected lane.
- `apps/worker/e2e/triage-lanes.e2e.test.ts` replays them over HTTP while the real mail service,
  GreenMail, Postgres and the Worker move the thread between lanes.
- Re-record after changing a question, the state, or a fixture (costs a fraction of a cent):

  ```bash
  pnpm --filter @omni/ai record   # runs under Doppler; or set TYPESAFE_API_KEY and run node eval/record.ts
  ```

# 0002: Triage on TypeSafe's Jev, summaries stay on Claude

Date: 2026-10-31 · Status: accepted · Ours-last rule replaced by ADR 0007

## Context

The spec (`docs/spec/v1.md`, "AI") runs triage and summaries on one provider: Claude Haiku 5.5
with structured output, returning a bucket and a self-reported confidence. Its "Considered and
rejected" table deferred Jev for triage ("early access, saves cents"). Two things moved since:

- Jev (`jev-1.14.0`, TypeSafe) is generally available. It answers typed questions about state we
  send and returns calibrated probabilities instead of generated text.
- The spec itself flags the weak spot of the current design: "A model's own confidence is not
  calibrated at first." The 0.85 auto-file threshold rests on that number.

Triage is a classification with an Unsure lane for doubt. That is the job Jev is built for.

## Decision

`triage()` takes a triage client that is either Jev or Claude, chosen by config:

- `TRIAGE_PROVIDER=jev|claude` when set; otherwise Jev whenever `TYPESAFE_API_KEY` is set, and
  Claude (the existing path, unchanged) when it isn't. `TRIAGE_PROVIDER=jev` without a key fails
  when the client is built rather than silently using Claude.
- Self-hosters without a TypeSafe account keep working on Claude alone.
- `summarize()` stays on Claude. Summaries are generation; Jev does not generate text.

On Jev, triage is a truth table in code over atomic judgments, not a single "which bucket?"
question:

1. One request per thread, plain `fetch` to `POST /v1/systemone` (no SDK: the JS SDK wants
   Node 22 and zstd, and we only need one endpoint). State is a JSON object of what a person would
   look at: sender, subject, the full latest `clean_text` (up to ~8k tokens), the last two earlier
   messages for context, thread length, whether the reader has replied, and list/automation
   headers stated as facts. Never HTML or attachments.
2. Five Nouls, all worded in `packages/ai/src/questions.ts`: does the sender expect a reply, was
   the message system-generated, is it bulk mail, does the sender promise to follow up, does it
   concern the reader personally.
3. `decide.ts` reads each Noul through the 0.7 / 0.3 bands and maps the readings to a bucket.
   Every settled combination has a row (a unit test enumerates all 32). When a judgment a row
   needs sits between the bands, the thread gets a best-guess bucket at confidence ≤ 0.5, so it
   lands in Unsure.
4. Confidence is the weakest link: the lowest probability, among the judgments the deciding row
   relies on, that the judgment reads the way the row needs. "Auto-file at 0.85" now means "every
   deciding judgment is at least 85% likely", built from calibrated probabilities. Jev's own
   `confidence` field is not used.
5. A failed call (network, non-2xx, malformed body, a missing answer) throws `JevError`, so the
   queue retries the job. It is never read as an answer. Jev has no refusal or invalid-output
   path, so the `fallback` source only occurs on Claude.

`triageByRule` (ours-last → `waiting_on_them`) still runs first on both providers. The
`TriageResult` shape is unchanged; it gains an optional `model` with the versioned Jev ID that
answered, for logs.

## What changes from the spec

- "One provider, one model, one code path" becomes two providers: Jev for triage, Claude for
  summaries, with Claude as the fallback triage provider by config.
- The 0.85 threshold stays, and stays in both `@omni/ai` (`DEFAULT_AUTO_FILE_THRESHOLD`) and
  `@omni/db` (`TRIAGE_AUTO_FILE_CONFIDENCE`). Its meaning is the same (below it → Unsure), so the
  db constant did not need to change. `@omni/db` should not import `@omni/ai` (it would pull in the
  Anthropic SDK), so the two stay in sync by hand until the threshold moves to config.
- The model is pinned to `jev-1.14.0`, not `jev-latest`, so an alias move can't shift answers
  under a tuned threshold.

## Cost

Jev bills input tokens only: $0.042 per million. A triage request is roughly 1k tokens (state plus
five questions), about $0.00004. Haiku 5.5 is $0.10 / $0.50 per million in / out, and a triage
call with low-effort thinking runs ~600 in and ~100 out, about $0.0001. Both are rounding errors at
our volume; cost is not the reason for the switch. Calibrated, auditable judgments are.

`ai_usage` keeps summing tokens from both providers. Jev tokens are far cheaper than Claude
tokens, so they count against the daily cap at an inflated rate. Triage ignores the cap (spec), so
the effect is that summaries pause slightly earlier; acceptable until `ai_usage` tracks cost.

## How we'll measure

`triage_feedback` records every manual re-sort (`from_bucket`, `to_bucket`). For the first weeks:

- Accuracy per provider: share of auto-filed threads that a person re-sorts. Needs the provider and
  model recorded alongside the triage result (the Worker logs `TriageResult.model`).
- Unsure rate: share of threads landing in Unsure. A high rate with low re-sorts of what was filed
  means the threshold or a band is too strict; a low rate with many re-sorts means too loose.
- Which judgment breaks: re-sorted threads replayed through `jevTriageRequest` show which Noul read
  wrong, so the fix goes into the state or that one question, not into thresholds.
- `pnpm --filter @omni/ai eval` runs synthetic threads through Jev and Claude side by side. Once
  feedback gives us real misfiled threads, anonymized versions become eval cases.

## Risks

- TypeSafe documents that adversarial text in the state "can move the answer". Email is untrusted.
  JSON state keeps injected text from forging fields, the bulk/automated judgments rarely flip on
  wording alone, and the worst case is a misfiled thread, which a person can re-sort. The model has
  no tools and no output we display.
- Jev is strongest in English. Non-English mail may land in Unsure more often; the eval should
  grow non-English cases.
- Another vendor holds email text. TypeSafe does not train on requests; ZDR is enterprise-only.
  Self-hosters choose by setting or not setting `TYPESAFE_API_KEY`.

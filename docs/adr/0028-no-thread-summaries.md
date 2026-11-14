# 0028: No AI thread summaries

Date: 2026-11-14 · Status: accepted · Amends: spec v1 ("An AI summary at the top of every
thread", "Summaries"), the daily token cap

## Context

Every new message in a thread that was not noise queued a Claude Haiku call that wrote one to
three sentences shown under the thread's subject. In use they restate what the subject and the
first lines of the message already say ("This is a welcome email from …, it asks for no
action"), and they cost a model call per message on every non-noise thread. Triage, which
decides where a thread goes, is what earns its call.

## Decision

1. **No summaries.** The AI queue triages and stops. `summarize()`, its prompt and its policy
   (`shouldSummarize`, `toPlainText`) leave `@omni/ai`, and the reader no longer shows a summary.
2. **The daily token cap goes with them.** `AI_DAILY_TOKEN_CAP` only ever paused summaries;
   triage is bounded by the workspace's monthly allowance (ADR 0015). `ai_usage` still records
   triage spend.
3. **`summary_message_id` stays as the job's done marker.** It is what makes a redelivered job a
   no-op; the queue now sets it after triage with `summary` null.
4. **Expand, then contract.** `threads.summary` stays in the schema and the API until no
   deployed code reads it; a later change drops the column and renames the marker.

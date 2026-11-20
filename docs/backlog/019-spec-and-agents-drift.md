# Spec v1 and AGENTS.md contradict the code; suggested replies and the token cap aren't built

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Docs                                         |
| Who      | Agent (AGENTS.md edits need Rodrigo's OK)    |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `docs/spec/v1.md:31,61,126,161,174,186,222,232-236,242,279,339`
- `packages/ai/src/reply.ts` (used only by its test)
- `docs/spec/modules.md`, `crm.md`, `mcp.md` ("Draft for review" though shipped)

## Problem

Agents are told to read the spec before designing, and it states things that are no longer true: thread summaries, one provider (Claude Haiku), RLS before outside customers (it is off on purpose; sign-up is open), and a daily AI token cap tracked in `ai_usage` (nothing reads `AI_DAILY_TOKEN_CAP` or `ai_usage`). Nothing serves the suggested replies `reply.ts` drafts.

## Evidence

Checked each claim against the code.

## Fix

Update `v1.md` to match the code (no summaries, the providers in use, RLS off, billing and open sign-up); close the answered open question; update the other specs' status lines. Decide on suggested replies: build the route with a cap that reads `ai_usage`, or delete `reply.ts` and its test. Plan the `threads.summary` column drop as its own PR.

## Done when

Docs-only PR; no code checks needed beyond `pnpm check`.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.

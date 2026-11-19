# Spec v1 and AGENTS.md contradict accepted ADRs; ADR 0022's suggested replies and token cap aren't built

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Docs                                         |
| Who      | Agent (AGENTS.md edits need Rodrigo's OK)    |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `AGENTS.md:21` (`summarize()` was removed under ADR 0028)
- `docs/spec/v1.md:31,61,126,161,174,186,222,232-236,242,279,339`
- `docs/adr/0022-ai-priority-tags-and-suggested-replies.md:41-50`, `packages/ai/src/reply.ts` (used only by its test)
- `docs/spec/modules.md`, `crm.md`, `mcp.md` ("Draft for review" though shipped)
- `docs/adr/0043-documents-in-storage.md:3-4`, `0037-client-dashboard-and-signing.md`, `0028-no-thread-summaries.md:23-24` (stale statuses)

## Problem

Agents are told to read the spec before designing, and it states things that are no longer true: thread summaries, one provider (Claude Haiku), RLS before outside customers (ADR 0005 keeps it off; sign-up is open per ADR 0018), and a daily AI token cap tracked in `ai_usage` (nothing reads `AI_DAILY_TOKEN_CAP` or `ai_usage`). ADR 0022 decisions 6-8 promise a suggested-reply route that doesn't exist.

## Evidence

Checked each claim against the code.

## Fix

Add pointers in `v1.md` to ADRs 0002, 0005, 0015, 0028, 0031; close the answered open question; update spec and ADR status lines. Decide on ADR 0022 6-8: build the route with a cap that reads `ai_usage`, or mark them deferred and delete `reply.ts` and its test. Plan the `threads.summary` column drop (ADR 0028 contract step) as its own PR.

## Done when

Docs-only PR; no code checks needed beyond `pnpm check`.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.

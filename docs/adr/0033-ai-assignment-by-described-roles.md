# 0033: AI assignment by described roles, and tag descriptions

Date: 2026-11-14 · Status: accepted · Extends ADR 0022

## Context

ADR 0022 had triage set a shared conversation's priority and tags, and resolve noise, but the
queue never passed the inbox's tags in or applied what came back, so every conversation stayed
Normal, untagged and Unassigned. Triage also had no way to know who on the team handles what, so
it could not route a conversation, and a tag's name alone is often too thin to judge ("Ops"?).

The workspace asked (Nov 14, 2026) for an AI settings page where each person's role and each tag's
meaning are written down, so Jev can file and assign with better judgment.

## Decision

1. **The queue applies helpdesk triage.** On a shared inbox, the AI job loads the inbox's tags
   (name order, first 25) and its teammates with a role (role order, first 10) into the triage
   input, and applies the result with `applyAiHelpdeskTriage` (`packages/db/src/ai-helpdesk.ts`)
   before saving the bucket, so a crash in between re-triages and re-applies as a no-op.
2. **A role is a sentence per member, per workspace** (`member_role_descriptions`). Blank clears
   it. Owners and admins set it on the AI settings page (`PUT /workspace/ai/members/:id/role`).
   Only the role text is sent to a model, never a name or address.
3. **A tag can carry a description** (`tags.description`) of what the team files under it. It
   joins that tag's question; a tag without one asks exactly what it asked before.
4. **Assignment is a judgment per teammate, decided in code.** Jev answers one Noul per teammate,
   "is this message about work handled by this role?". `pickAssignee` hands the conversation to
   the most likely settled yes (at or above 0.7), and only when the bucket is `needs_reply`: a
   receipt that mentions billing asks nothing of anyone. Claude (self-hosters) picks a neutral
   label (`teammate_1`, ...) or `none` in the same structured output, under the same bucket rule.
5. **Never over a person, and never over round-robin.** AI assigns only an unassigned, unresolved
   conversation that no member has ever assigned or unassigned. An inbox with round-robin on is
   already assigned at ingest, so round-robin wins there. The `assigned` event carries
   `source: "ai"` and no actor, and the assignee is notified as for any assignment.

## Consequences

- Describing roles is the switch: with none, nothing is assigned. No separate toggle.
- Accuracy is read from `conversation_events`: AI changes carry `source: "ai"`, and a member's
  later change to the same field is the correction. The `triage_feedback` table keeps bucket
  re-sorts only; ADR 0022 §5's field-level feedback is left for when we tune.
- Roles and tag descriptions are prompt text. A change re-shapes the request, so the recorded
  fixtures (`fixtures/triage/helpdesk.json`) are re-recorded when the questions change.

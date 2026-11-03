# 0008: An organization is the workspace; a shared mailbox's access list is a Better Auth team

Date: 2026-11-03 · Status: accepted

## Context

Who can see what in Omni comes from two places: Better Auth organizations (users, members,
roles, invitations) and our `mailbox_access` table (which member sees which mailbox). Every read
goes through `db.forMember(memberId)`, which inner-joins `mailbox_access` and requires the row's
org to be the member's org (ADR 0005). Nothing in the app managed `mailbox_access` for shared
mailboxes: grants came from the `mailbox:add` CLI or by hand.

The proposal was to map both concepts onto Better Auth: **organizations = domains** and
**teams = shared inboxes**. This ADR evaluates each half against the spec.

## Decision

1. **An organization stays the workspace (the company) and owns many domains.** It is not one
   organization per domain.
2. **Each shared mailbox has one Better Auth team** (`teams`, `team_members`), linked by
   `mailboxes.team_id`. The team's members are the people who can see that mailbox: adding
   someone to the team grants access, removing them revokes it. The team is named after the
   address (`support@acme.com`).
3. **`mailbox_access` stays**, as the indexed table every read joins. For a shared mailbox it is
   now derived from the team: `syncMailboxAccess` makes the grants equal the team's members who
   belong to the mailbox's org, no more and no fewer. Reads (`forMember`, `member-mail.ts`,
   realtime fan-out) do not change.
4. **Personal mailboxes have no team.** They keep their single `owner` grant, as before.
5. **Per-person state is unchanged.** Read state, done and defer on a shared mailbox stay per
   member in `thread_state` (spec: "Sync rules"; ADR 0007).

## Why not one organization per domain

- **It breaks the core promise.** The spec's first goal is "every inbox across every domain in
  one place". `listThreads`, `counts` and `search` read within the member's active org (the
  `members` join requires it), and a session has one active org. One org per domain would mean
  switching orgs to read another domain's mail. Making the inbox read across orgs would undo the
  tenant boundary ADR 0005 relies on.
- **It splits what belongs together.** Billing, invitations, roles, settings, the AI daily cap
  (`ai_usage` is per org) and triage feedback are all per org. A company with four domains would
  invite each person four times and manage four sets of roles.
- **Threads cross domains.** A customer writes to `hello@a.com` and cc's `billing@b.com`. Today
  both copies are in one org; per-domain orgs would spread one conversation over several tenants.
- **Domains already have a home.** The onboarding work (#61) adds `mail_domains (org_id,
  domain)`: an org claims many domains, each unique across orgs. That is the "which domains
  belong to whom" record, without making a domain a tenant.

## Why teams for shared mailboxes

- **The concept fits.** A shared inbox is a named group of people inside the workspace, which is
  what a Better Auth team is. Invitations can already name a team, so "invite Bea to Acme and put
  her on Support" is one step.
- **One source of truth people manage.** The team is what the app edits and what Better Auth's
  own team endpoints edit; `mailbox_access` follows. Before this, nothing in the product
  managed shared access.

## Why keep `mailbox_access` (derived) instead of reading teams directly

- **The read path keeps its shape and speed.** Every member read starts from
  `mailbox_access (member_id)` and its primary key `(mailbox_id, member_id)`, then walks one
  mailbox's index at a time (ADR 0007's numbers). Reading teams instead would add
  `team_members → members` joins (team members are keyed by user, not member) to every thread
  list, count and search, and a second path for personal mailboxes, which have no team.
- **One isolation check.** `forMember`'s leak tests keep covering every read, with no change.
- **It converges.** `syncMailboxAccess` recomputes the grants from the team each time, so a
  retry, a second run, or a run after a missed one all end in the same rows.

## How it stays in sync

| Change                                          | What keeps `mailbox_access` right                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Shared mailbox created (`saveMailbox`)          | Creates the team in the same transaction, seeded with the owner grant.  |
| `PUT` / `DELETE /api/mailboxes/:id/members/:id` | Changes the team and syncs, in one transaction under a row lock.        |
| Better Auth `add-team-member` / `remove-…`      | `afterAddTeamMember` / `afterRemoveTeamMember` hooks sync.              |
| Invitation that names a team is accepted        | `afterAcceptInvitation` hook syncs those teams.                         |
| Member removed from the org                     | Better Auth deletes their team rows; the grant cascades with `members`. |
| Better Auth `remove-team` on a mailbox's team   | Refused (`beforeDeleteTeam`): the team is the mailbox's access list.    |
| Existing shared mailboxes (before this change)  | `pnpm --filter @omni/db mailbox-teams:backfill`, seeded from grants.    |

Until a shared mailbox has a team, its grants are left alone, so deploying before the backfill
changes nothing for anyone. Listing or changing a mailbox's members also creates its team on
first use, so the backfill is a tidy-up, not a prerequisite.

- **API.** `GET /api/mailboxes/:id/members` (anyone who can see the mailbox, or an org owner or
  admin), `PUT` and `DELETE /api/mailboxes/:id/members/:memberId` (org owners and admins). `PUT`
  and `DELETE` set an absolute state, so they need no `Idempotency-Key`: a retry is a no-op. A
  personal mailbox, another org's mailbox, or another org's member answers 404.
- **Writes bypass Better Auth's endpoints but match its rows.** Ours set `membership_key` the way
  Better Auth does (`sha256([teamId, userId])`) and recount `member_count`, so the two paths never
  make a second row for one person (proven in `apps/worker/e2e/mailbox-members.e2e.test.ts`).
  We write directly so the team and the grants change in one transaction, and so the mail
  service, which has no session, can create a team.

## Consequences

- **Spec departure (small).** The spec's `mailbox_access` row says "who can see a mailbox"; that
  is still true, but for a shared mailbox it is now derived from the team. Granting a shared
  mailbox by inserting a `mailbox_access` row stops working once the mailbox has a team (the
  next sync removes it). Use the API or the team.
- **The mailbox's creator is on its team** (the owner grant seeds it) and can be removed like
  anyone else. Re-running `saveMailbox` (a new password) does not put them back.
- **Org match is enforced in code, not by a foreign key.** `teams` is generated by Better Auth,
  so it has no `(id, organization_id)` unique key for a composite foreign key like the one
  pinning mail rows to their mailbox's org. `syncMailboxAccess` only grants members of the
  mailbox's org through a team of the mailbox's org; a mismatched link grants nothing.
- **`team_members` has no `org_id`.** Like `users` and `sessions`, it is a Better Auth table; its
  org is its team's `organization_id`. Every table we own still has `org_id`.
- **Shared migration order with #61.** Both add a migration after `0005`. Whichever lands second
  merges `main` and regenerates its migration with `db:generate`.
- **Not in this change.** Telling the open apps of someone just added or removed (a realtime
  event), and an assignee rule for shared threads (spec: `assignments`). Both are follow-ups.

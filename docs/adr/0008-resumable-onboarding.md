# 0008: Resumable onboarding and the workspace switcher's data

Date: 2026-11-03 · Status: accepted

## Context

Onboarding (ADR 0007) decided where to resume from what existed: an owner or admin whose
workspace had no mailboxes was sent back to `/onboarding`. That loses the invite step, treats a
workspace with one mailbox as finished, and gives a switcher nothing to show about unfinished
workspaces. The spec's data model has no setup state.

## Decisions

### An `org_setup` table, one row per org, only moving forward

`org_setup (org_id primary key, step)`, where `step` is the enum `created → domain_added →
dns_verified → mailboxes_created → invites_sent → complete`. Additive, keyed by `org_id`.

- Each step advances it with one upsert using `greatest()` over the enum's order, so a retry, a
  double submit or a late request never moves it back, and concurrent writers settle on the
  furthest step. (`advanceOrgSetup` in `@omni/db`.)
- An org with no row is derived, not backfilled: `complete` if it has any mailbox, else
  `created`. Orgs made by `org:create` + `mailbox:add`, or before this table, keep working with
  no migration of data; a fresh `organization.create` needs no hook to start at `created`.
- Advanced by: `POST /api/onboarding/domains` and `/domains/:id/check` (`dns_verified` when every
  record passed, else `domain_added`; read from the domain view, so claim verification stays
  owned by the domain code), `POST /api/onboarding/mailboxes` (`mailboxes_created`), Better
  Auth's `afterCreateInvitation` hook (`invites_sent`, only once mailboxes exist: an invitation
  sent from settings mid-setup must not skip steps), and `POST /api/onboarding/complete`
  (`complete`, refused before a mailbox exists).
- `GET /api/me` and `GET /api/onboarding` carry it as `setup`. The web guards send owners and
  admins of an unfinished workspace to `/onboarding` (except `/settings`); plain members are not
  redirected, since they cannot finish setup.

### `GET /api/workspaces` for the switcher

Every org the signed-in user belongs to, with name, logo, role, `setup`, and the mailboxes
`{ id, address, kind }` their member in that org holds a grant on. Like `forMember`, a mailbox
shows only through a grant to a member of the mailbox's own org (`listUserWorkspaces`, with an
isolation case in `for-member.e2e.test.ts`). Shared vs. personal is the `kind` field only, so
moving shared inboxes to Better Auth teams later changes the source of grants, not this shape.

## Not stored

A bring-your-own-host domain's IMAP and SMTP servers are not saved (they travel only with a
mailbox's login), so a resumed setup on that path asks for them again before mailboxes.

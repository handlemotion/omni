# 0026: Member inboxes are a first-class resource: issue, list, remove, and survive offboarding

Date: 2026-11-13 · Status: accepted · Amends: ADR 0017 (admin view), ADR 0008 (shared members API)

## Context

The product already has the shape: every company member can own personal inboxes, shared inboxes
are teams, and owners and admins see who has what without reading it (ADRs 0008, 0017, 0024). The
API that carries it grew one step at a time and is hard to read and to build on:

| Today                                               | Problem                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /api/onboarding/mailboxes` with `forMemberId` | Issuing a teammate's inbox lives under onboarding, and `kind` is guessed from whether the address matches.   |
| `GET /api/workspace/mailboxes`                      | People joins it to the member list in the browser (`workspace-pages.tsx` `InboxDescription`).                |
| `DELETE /api/workspace/mailboxes/:id/hosted`        | Only Purelymail inboxes can be removed; an `imap` or `gmail` inbox cannot.                                   |
| `PUT/DELETE /api/mailboxes/:id/members/:memberId`   | Shared-inbox people sit next to the personal ones under `/mailboxes`, with no "create a shared inbox" route. |
| Member removed from the org                         | The grant cascades, the inbox keeps syncing with `owner: null`, and nothing offers to deal with it.          |
| "Create inbox" in the People row menu               | Shown only when a person has none, so a second inbox cannot be issued from settings (the API allows it).     |
| Invitation                                          | Cannot carry an inbox, so every new hire needs a second step by an admin after they accept.                  |

## Decision

### 1. One admin surface: `/api/workspace/...`

Owners and admins of a **company** workspace only; members get 403, a Personal space 404. Nothing
here returns mail or adds a grant on someone else's personal inbox: the privacy line of ADR 0017
stays in the API.

| Route                                                  | Does                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /workspace/members`                               | Members with role and `inboxes: [{ id, address, provider, status, syncedAt }]`. One call for People.         |
| `GET /workspace/members/:memberId/inboxes`             | The same list for one person.                                                                                |
| `POST /workspace/members/:memberId/inboxes`            | Issue a personal inbox: `{ domainId, localPart, login? }` (login only on `imap` domains). Always `personal`. |
| `GET /workspace/inboxes`                               | Every mailbox (today's `/workspace/mailboxes`, renamed), plus `orphaned: true` when owner left.              |
| `DELETE /workspace/inboxes/:id`                        | Disconnect any provider. Purelymail: revoke the app password, keep the user and mail (as today).             |
| `POST /workspace/inboxes/:id/owner`                    | Give an orphaned inbox to a member: `{ memberId }`. See decision 3.                                          |
| `POST /workspace/inboxes/:id/shared`                   | Turn an orphaned inbox into a shared one: `{ memberIds[] }`. See decision 3.                                 |
| `POST /workspace/shared-inboxes`                       | Create a shared inbox: `{ domainId, localPart, login?, memberIds[] }`. Always `shared`, team seeded.         |
| `GET /workspace/shared-inboxes/:id/people`             | Who sees it (today's `GET /mailboxes/:id/members`).                                                          |
| `PUT/DELETE /workspace/shared-inboxes/:id/people/:mid` | Add or remove someone (today's routes, same semantics: absolute state, no idempotency key).                  |

Every write is idempotent on its natural key (org, address) or sets an absolute state, as now.
The handlers reuse what exists: `orgMember`, `mailboxAtAddress`, `addMailboxMember`,
`removeMailboxMember`, `listWorkspaceMailboxes`, and the mail service's `provision/mailbox` and
hosted-disconnect paths. A new mail-service route disconnects non-Purelymail inboxes (stop sync,
drop the sealed credential, delete the index), since the Worker never holds credentials.

### 2. An invitation can carry an inbox

`POST /workspace/invitations` (wrapping Better Auth's `createInvitation`) takes `email`, `role`,
an optional `inbox: { domainId, localPart, login? }` and optional `sharedInboxIds` (their Better
Auth teams, which invitations already support).

The inbox is made at invite time, through the same path as decision 1, but with no owner: the
mail service saves it without a grant (`ownerMemberId: null`, personal only). It is orphaned, so
nobody can open it and it does not sync, and it is linked in `invitation_inboxes (org_id,
invitation_id, mailbox_id)`. That also reserves the address: issuing it to anyone else is a 409.
`afterAcceptInvitation` gives it to the new member (decision 3's give, safe to run twice). An
invitation that is cancelled or expires leaves the inbox orphaned, for an owner or admin to give,
share or remove like any other. On an `imap` domain the inviter types its login, as when issuing;
a `gmail` domain cannot be pre-issued (the person connects their own account after joining).

### 3. Offboarding keeps the inbox with the company, unread

When a member is removed, their personal inboxes stay in the company (the domain is the
company's, ADR 0024) with no grant: `orphaned`. Nobody can open it and it stops syncing: the mail
service keeps connected only mailboxes that are not disabled and, when personal, have an owner in
the org (`listServiceMailboxes`). That is derived, not a flag a job sets, so it converges and needs
no hook on member removal. The mail keeps arriving at the host.

An owner or admin then does one of three things, each recorded (decision 4):

- **Give to a member** (`owner`): it becomes their personal inbox, old mail included, as with a
  Google Workspace data transfer. Read, done and defer stay per person, so the new owner starts
  with their own.
- **Turn into a shared inbox** (`shared`): its team is created with the people named, so a support
  team picks up the departed person's clients.
- **Remove** (`DELETE`): disconnect, keep the mail at the host.

Only an orphaned inbox can be given away or turned into a shared one. A member's own inbox never
changes hands while they are in the company.

### 4. Admin actions are recorded

`workspace_events (org_id, actor_member_id, kind, mailbox_id, member_id, at)` for: inbox issued,
removed, owner given, shared inbox created, person added or removed. `GET /workspace/events` for
owners and admins. No mail content. This is what makes "admins can't read it" checkable.

### 5. Every member sees at least one inbox

Decided 2026-11-13. In a company, every member can open at least one inbox: their own, or a shared
one. Personal is not required.

- **Inviting** needs `inbox` (decision 2) or at least one shared inbox. Without either, 422, but
  only when the workspace could give one: it has a shared inbox, or a domain on Omni's host. A
  company whose mail stays at Google or on its own host has neither until people connect their
  own after joining (ADR 0024), so its invitations need none.
- **Taking away the last one** is refused with 409: removing someone from their only shared
  inbox, or disconnecting their only personal inbox while they have no shared one. Removing the
  member from the company is always allowed.
- **Members who already have none** are not blocked: `GET /workspace/members` reports
  `inboxCount: 0` so People can show them, and owners fix it with decision 1.
- **Owners and admins** follow the same rule; a new company's first owner gets theirs in setup.

## Rollout (expand, then contract)

1. Add the new routes beside the old ones; old routes call the same functions.
2. Add `invitation_inboxes` and `workspace_events` (additive schema).
3. Web moves to the new routes (Rodrigo): People uses `GET /workspace/members`; "Add inbox" is
   always in the row menu; orphaned inboxes show on Inboxes with give to, make shared and remove.
4. Contract once no client calls them: `forMemberId` on onboarding, `/workspace/mailboxes`,
   `/workspace/mailboxes/:id/hosted`, `/mailboxes/:id/members*`.

## Proof

E2E on the real Worker, mail service, GreenMail and Postgres: issue two inboxes to one member and
see both on `GET /workspace/members`; a member (not admin) gets 403 on every route and no admin
route returns a thread; invite with an inbox, accept twice, one mailbox; remove a member, the
inbox reads `orphaned` and stops syncing; give it to another member and they can open it while
the admin still cannot; disconnect an `imap` inbox. Purelymail parts run in the live suite when
asked (`PURELYMAIL_E2E=1`).

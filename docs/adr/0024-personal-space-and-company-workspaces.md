# 0024: A Personal space for every person; companies own their domains; a login opens its own workspace

Date: 2026-11-13 · Status: accepted · Amends: ADR 0008 (organizations), ADR 0014 (sign-in),
ADR 0015 (billing), ADR 0023 (where a Google account lands), spec v1 "Data model"

## Context

Omni is a mail client and a shared-inbox helpdesk (ADR 0021). Personal mail comes through a
Google connection (ADR 0023). Today every mailbox lives in a company-style workspace (a Better Auth
organization, ADR 0008), and that causes four problems:

- **Personal mail sits inside a company.** A connected Gmail lands in whichever workspace is
  active (`apps/worker/src/routes/connect.ts`, `connectGoogle` in `apps/mail`). If the person
  leaves, their Gmail leaves with the company's data. Admins only see that it exists (ADR 0017),
  but it does not belong there.
- **A work address is a key to everything.** Whoever runs acme.com's mail (a Google Workspace
  admin, the mail host's account owner, the next hire given the same address) can read the magic
  link sent to ana@acme.com. Through ADR 0014's "any verified address signs in", that opens all
  of Ana's account, personal mail included.
- **Everyone must create a company.** A user with no organization is sent through Workspace,
  Team and Plan onboarding (`apps/web/src/lib/guards.ts`, `apps/web/src/lib/onboarding.ts`),
  even if all they want is their own Gmail.
- **Shared addresses look like they need seats.** On Google every mailbox is a paid seat, which
  pushes teams toward sharing one account by hand.

## Decision

### 1. Two kinds of workspace

A workspace is a Personal space when a `personal_spaces` row names it (one per user), and a
company otherwise. It lives in our own table, not in a column on Better Auth's `organizations`,
so the auth schema and our deploys stay independent. Every table keeps `org_id`, and every read keeps
going through `forMember` / `forUser`: a Personal space is an organization, not a special case.

- **Personal space**: one per person, created with the user and never deleted on its own. It
  holds the person's **cluster**: the mail accounts they connect themselves (a personal Gmail).
  It has exactly one member, its owner. It refuses invitations, teams, shared mailboxes and domain
  claims. It is **free**: every billing check passes for it, and it is never read-only. It can
  never start a plan; one it somehow has can still be managed in the portal, so it can be
  cancelled.
- **Company workspace**: what ADR 0008 calls a workspace. It owns its domains (ADR 0010), its
  work mailboxes, its shared inboxes and the helpdesk. It must claim at least one domain before it
  has mail; a company with no domain is out of scope for now. People join only by invitation.

### 2. The address decides where a mailbox lives

When a mailbox is connected or provisioned, its address picks the workspace, not the session's
active workspace:

- If a company has a **locked claim** on the address's domain (ADR 0010), the mailbox is that
  company's. The person who connected it must be a member there, and owns it as their personal
  inbox (`kind: personal`, an owner grant). Admins see that it exists, as before (ADR 0017).
- **Anything else** (gmail.com, or a domain nobody has claimed) goes into the connecting person's
  Personal space. Free mail domains need no list: nobody can publish a challenge on gmail.com.

**A claim that comes later moves the mailbox.** When a company locks a domain, mailboxes on it
in members' Personal spaces move to the company. They are moved by reconnecting them there and
syncing again, not by rewriting rows: the provider holds the mail and a re-sync converges
(ADR 0013). A mailbox whose owner is not a member of the company stays where it is until they
join.

A re-sync alone is not a complete move: read, deferred and done exist only in Omni (ADR 0013).
So a move goes in steps, each one safe to repeat:

1. The company gets its own copy, which syncs while the old copy keeps running.
2. Once the copy has finished its first sync, each thread's state is carried to the matching
   thread in the copy, matched by the provider's thread id or a shared Message-ID.
3. Only then is the old copy deleted.

A mailbox with drafts or unsent actions waits until they are sent or discarded, since both live
only in Postgres. The company's existing mailbox at that address is reused only if it is a
personal inbox the same person owns; a shared inbox is never taken over. The nearest lock decides
(`team.acme.com` over `acme.com`).

**Existing Gmail accounts inside companies move the same way:** a backfill reconnects each
`provider = gmail` personal mailbox whose domain the company has not claimed into its owner's
Personal space.

### 3. A login opens only the workspace it belongs to

A session records which key opened it, as a `session_scopes` row naming the company (no row
means unscoped):

| Signed in with                                                                             | Session scope | Opens                                       |
| ------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------- |
| An address on a company's claimed domain (magic link, or Google sign-in with that account) | that company  | That company only                           |
| Any other address (personal Gmail, any unclaimed domain)                                   | none          | Personal and every company the person is in |
| A passkey                                                                                  | none          | The same                                    |

- **The server enforces it, in one place.** `forUser` adds the scope to its grantee condition, so
  every cross-workspace read (threads, counts, search, thread routes, realtime) sees only the
  scoped company's members. Choosing an active workspace outside the scope answers 403.
- **A work address never stops working.** It keeps signing in; it simply opens the company that
  owns it. A nosy admin or a reused address reaches only mail that company already owns.
- **Leaving a company** removes the member, so that company's work address opens nothing, and
  the person loses access to the work mailbox, which the company keeps. Their Personal space is
  untouched.
- **A scoped session cannot widen itself.** It cannot add a sign-in method (an extra email, a
  passkey, a linked Google account, a changed primary); each would let whoever holds the company
  address sign in unscoped later. Adding one takes an unscoped session. It also cannot name
  another organization in any organization request, or create or delete one. Deleting a company
  ends the sessions scoped to it first, and a session missing from the database is signed out,
  never unscoped.
- Better Auth's multi-session stays what ADR 0014 made it: separate identities on one device.
  It is not how one person reaches their own workspaces.

### 4. Shared inboxes come in by forwarding

A company keeps its domain's mail wherever it is (Google, Microsoft, or Omni's host). A shared
address such as support@ forwards to a long, random Omni address on one receiving domain that
Omni controls. That domain is configuration (`INBOUND_DOMAIN`), so a self-hoster uses their own.
The random part is the only thing that makes the address hard to guess, so it is generated with a
CSPRNG and never derived from the company or the address. Replies go out as support@acme.com,
which needs the company's SPF and DKIM records for Omni's sending host, and no MX change.

### 5. Sign-up and onboarding

Signing up creates the user and their Personal space together, with setup complete, so no user
is ever without a workspace. Creating a company is an optional step, not the way in.

Company setup claims the company's domain before it connects any Google account, because an
account goes where its address belongs: connected first, it would open in its owner's Personal
space. A domain whose mail stays at Google is claimed with its ownership record alone (provider
`gmail`: no mail records, never added at the mail host); its accounts then connect one by one
and land in the company.

## Departures

- **ADR 0014's "any verified address signs in" stays,** but what a sign-in opens now depends on
  the address (decision 3).
- **ADR 0015's "every workspace has a plan"** applies to companies only.
- **ADR 0023's "a Google account is a personal mailbox in the workspace"** becomes decision 2.

## Rollout (expand, then contract)

1. Add the `personal_spaces` (organization, unique user) and `session_scopes` (session, company)
   tables. Create Personal spaces for new users; an existing user gets theirs at their next
   sign-in. Personal spaces refuse invitations, teams, shared mailboxes and domains.
2. Sessions record their scope at sign-in; `forUser` and the active-workspace switch enforce it.
3. Connect and provisioning route by address; a lock moves mailboxes; the Gmail backfill runs.
4. The API exposes `kind` on workspaces, and compose can send from any address the session can
   open.
5. Web (Rodrigo): every user has a space, so the no-workspace state and forced company
   onboarding go; the switcher shows Everything / Personal / each company, and focusing an account
   or a workspace filters instead of switching; Personal hides company settings.
6. Contract, once production no longer needs it: remove the "create a workspace first" paths,
   and connect every Google account by its address (no "join the open workspace" mode).

Forwarding for shared inboxes (decision 4) is its own layer, and needs Omni's receiving domain
first.

## Consequences

- One person, one identity (ADR 0014), and now one Personal space: a cluster has a home that does
  not depend on any employer.
- Every user now has at least one organization, so a "no member" state is no longer normal.
  Code that treats it as onboarding is removed in the contract step.
- A Personal space depends on Google's app verification and CASA for more than 100 people
  (ADR 0023). That is unchanged, but more of the product now rests on it.
- Each company domain still belongs to exactly one workspace (ADR 0010); one company may hold
  several (ADR 0008).

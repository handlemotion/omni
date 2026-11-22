# Billing: one flat price per workspace, a week's trial, and hard caps

Nov 22, 2026 · Agreed · Replaces the one flat plan in `docs/spec/v1.md` ("Since built")

## Summary

Omni is billed per workspace, never per member, the way Google Workspace and Skiff were meant to
feel for a small team: one modest price, no bill that grows with every hire. Omni is paid only:
anyone who wants it free hosts it themselves (billing is off unless Stripe is configured). A
workspace gets one free week to try it, then pays. Two plans are size bands, **Team** and
**Business**, and every limit is a hard cap, so a bill is the plan's price and nothing more,
except extra Drive storage, which a workspace opts into with a card.

## Plans

| | Team | Business |
| --- | --- | --- |
| Price | $25 a month, $250 a year | $60 a month, $600 a year |
| Members (open invitations count) | 15 | 75 |
| Inboxes, personal and shared | 30 | 150 |
| Custom domains | 5 | 20 |
| Drive storage | 100 GB | 500 GB |
| AI-triaged emails a month | 20,000 | 75,000 |
| Drafted replies and asks a month | 250 | 1,000 |
| Meetings transcribed a month | 15 hours | 100 hours |

Past 75 members a workspace talks to us. Amounts live in Stripe; the limits are `PLAN_LIMITS` in
`packages/contracts/src/plans.ts`, the one place they are written.

**Why these numbers.** What a workspace costs us grows with four things: AI triage (Haiku, about
$0.0003 an email), drafted replies (Opus, about $0.03 each), meeting transcription and notes
(about $0.25 an hour, `meetings.md`) and Drive (R2, $0.015 a GB a month). Mail hosting, the Worker,
Postgres and the mail service are a fixed $15 or so a month for everyone. At every limit used up,
Team costs us about $19 a month and Business about $70; most workspaces use a fraction of their
limits.

## The trial and what happens without a plan

- **A week's trial, no card.** An owner or admin starts it (`POST /api/billing/trial`, Team by
  default or Business), once per workspace and once per account, ever. It is a Stripe
  subscription in `trialing`: the plan's limits apply, and it ends cancelled unless a card is
  added. `BILLING_TRIAL_DAYS` sets the length (default 7; `0`: no trial).
- **No plan, no trial: read-only.** Mail keeps syncing and reading; nothing is sent, changed or
  triaged (`402 BILLING_INACTIVE`), and setup still works (domains, inboxes, invitations, billing
  itself: `READ_ONLY_ALLOWED`). Setup is held to Team's caps. A workspace finishes setup only once
  it has a trial or a plan.
- **A Personal space is billed like any workspace.** It gets the one trial, then pays or is
  read-only (see "One kind of workspace").

## How the limits behave

- **Caps count what the workspace holds now**: members (and invitations still open), inboxes that
  are not disabled, domains verified or with a claim still pending, and bytes stored. Adding one
  past the cap answers `402 PLAN_LIMIT` with `details: { cap, max, held, plan }`. Nothing is
  checked on reads, edits or removals, and nothing a workspace holds is taken away: one over a cap
  after a move down keeps it all and only adds once back under.
- **Caps are checked before the create**, outside its transaction (members are written by Better
  Auth, inboxes by the mail service). Two admins adding at the same instant can pass a cap by one;
  that is accepted. Accepting an invitation checks the member cap again.
- **Meters count per usage month**, the plan's billing period. Each costly thing is claimed once
  by what it was done to (an email, a draft, a recording), under a per-workspace lock, before the
  costly call runs: a retried or redelivered job never counts twice, and concurrent jobs cannot
  overshoot. Past the month's allowance, triage pauses until the next month (mail still arrives),
  and a route answers `402 ALLOWANCE_REACHED` with `details.resetsAt`.
- **A recording is counted when it ends**: starting one needs minutes left this month; its minutes
  are then counted whole, so one recording can pass the allowance, and the next cannot start.

## Where each limit is enforced

One decision, `planOf` in `@omni/db`: a subscription in good standing (`active`, `trialing`,
`past_due`) gives its plan, a paid one Omni cannot name is Team (the first plan), anything else is
no plan. The Worker's `entitlements` adds the usage month and read-only; `requireCap` /
`capRefusal`, `gateMeter` / `requireMeter` / `hasAllowance` and `requireWritableWorkspace` are the
guards. Each cap is counted in one place, `capUsage`.

| Limit | Checked at |
| --- | --- |
| Members | Better Auth's `beforeCreateInvitation`, `beforeAddMember`, `beforeAcceptInvitation`; `POST /workspace/invitations` before it makes the invitee's inbox; accepting a join request |
| Inboxes | `provisionMailbox` (every Worker route that makes one); the mail service when a Gmail account lands in a workspace (`planCaps` on the connect call), so the cap is the landing workspace's |
| Domains | `POST /onboarding/domains`, unless the workspace already claims that domain; `POST /onboarding/domains/:id/transfer`, unless the destination already holds it |
| Storage | `storageLimit`, with the plan's GB |
| Triage | `gateTriage` in the AI job, only when a model would run |
| Meeting minutes | `POST /api/meetings` needs minutes left (`hasAllowance`); `POST /api/meetings/:id/stop` counts the recording's minutes, keyed by its audio file, so a retried stop counts once |
| Drafts and asks | `gateMeter` with `assist`, before the model runs: Meetings' Ask (`POST /api/meetings/ask`) now, drafted replies when they ship |

## Moving between plans

- No plan to a plan is a trial (above) or Stripe Checkout (`POST /api/billing/checkout` with
  `plan` and `interval`).
- Plan to plan is `POST /api/billing/plan`: the subscription's plan item is swapped in place. A
  move up (a bigger plan, or yearly) is invoiced at once with proration and applies only once that
  invoice is paid (`payment_behavior: pending_if_incomplete`), so a failing card never unlocks the
  bigger plan; it answers `pending: true`. A move down is credited on the next invoice and applies
  at once. A yearly plan carries no metered price, so moving to one stops extra storage being
  billed. A subscription with a schedule is changed in the portal.
- Cancelling is in the portal; the plan ends with its period, and the workspace is read-only.
- Stripe is the authority: the webhook and the daily reconcile map each subscription's price to
  its plan, so a change made in Stripe's dashboard or portal lands too.

## Stripe

One product per plan, each with a monthly and an optional yearly price; extra storage is its own
metered price on a Billing Meter. Config is ids only: `STRIPE_PRICE_MONTHLY` /
`STRIPE_PRICE_YEARLY` (Team, the names from before there were tiers),
`STRIPE_PRICE_BUSINESS_MONTHLY` / `STRIPE_PRICE_BUSINESS_YEARLY`, the storage pair and
`BILLING_TRIAL_DAYS` (`docs/self-hosting.md`). With no `STRIPE_SECRET_KEY` there is no plan and no
limit.

## Not yet

- The `assist` meter has no caller until drafted replies ship; it must call `gateMeter` before
  the model runs.
- Disputes, refunds and early fraud warnings from Stripe are not handled yet.

## One kind of workspace

A Personal space is the workspace Omni makes for a person (Just me, mail on an address no company
claims, a Drive item shared with them). It is a workspace like any other: it takes invitations,
teams, shared inboxes, a CRM, Talk and a Shared drive, and an owner may delete it. It has a plan,
caps and meters, and without a trial or a plan it is read-only. Someone who was only shared a
file never pays: a shared item is read and changed under the sharing workspace's plan
(`/api/storage/shared`), never their own.

What still sets one apart is where it comes from, not what it may do:

- `personal_spaces` names each person's own one, so mail and shared files have somewhere to
  land, and it is made on demand (`v1.md`).
- Onboarding's status leaves it out (`organization: null`), so "Set up a company" from it starts
  a new workspace instead of resuming this one, and setting up a mailbox there by address makes
  it the person's own.
- Without billing, `STORAGE_PERSONAL_GB` still caps it.

## Plan

1. **Plans and limits**: catalog, usage meters, guards, tiers in Stripe, the trial, moves between
   plans.
2. **Web billing screens**: plan and trial, usage, plan changes, refusals that point to billing.
3. **One kind of workspace**: remove every Personal-space difference.

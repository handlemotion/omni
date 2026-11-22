# Billing: one flat price per workspace, a Free plan, and hard caps

Nov 22, 2026 · Agreed · Replaces the one flat plan, the trial and the read-only state in
`docs/spec/v1.md` ("Since built")

## Summary

Omni is billed per workspace, never per member, the way Google Workspace and Skiff were meant to
feel for a small team: one modest price, no bill that grows with every hire. Every workspace
starts on **Free** and can use everything except meetings, within limits. Two paid plans are size
bands: **Team** and **Business**. Every limit is a hard cap, so a bill is the plan's price and
nothing more, except extra Drive storage, which a workspace opts into with a card.

## Plans

| | Free | Team | Business |
| --- | --- | --- | --- |
| Price | $0 | $25 a month, $250 a year | $60 a month, $600 a year |
| Members (open invitations count) | 3 | 15 | 75 |
| Inboxes, personal and shared | 5 | 30 | 150 |
| Custom domains | 1 | 5 | 20 |
| CRM records (people, companies, deals) | 500 | no limit | no limit |
| Drive storage | 5 GB | 100 GB | 500 GB |
| AI-triaged emails a month | 1,000 | 20,000 | 75,000 |
| Drafted replies and asks a month | 25 | 250 | 1,000 |
| Meetings transcribed a month | none | 15 hours | 100 hours |

Past 75 members a workspace talks to us. Amounts live in Stripe; the limits are `PLAN_LIMITS` in
`packages/contracts/src/plans.ts`, the one place they are written.

**Why these numbers.** What a workspace costs us grows with four things: AI triage (Haiku, about
$0.0003 an email), drafted replies (Opus, about $0.03 each), meeting transcription and notes
(about $0.25 an hour, `meetings.md`) and Drive (R2, $0.015 a GB a month). Mail hosting, the Worker,
Postgres and the mail service are a fixed $15 or so a month for everyone. At every limit used up,
Free costs us about $1 a month, Team about $19 and Business about $70; most workspaces use a
fraction of their limits.

## How the limits behave

- **Caps count what the workspace holds now**: members (and invitations still open), inboxes
  that are not disabled, domains verified or with a claim still pending, CRM records archived or
  not, and bytes stored. Adding one past the cap answers `402 PLAN_LIMIT` with
  `details: { cap, max, held, plan }`. Nothing is checked on reads, edits or removals.
- **Meters count per usage month**: a paid plan's billing period, or the calendar month in UTC on
  Free. Each costly thing is claimed once by what it was done to (an email, a draft, a
  recording), under a per-workspace lock, before the costly call runs: a retried or redelivered
  job never counts twice, and concurrent jobs cannot overshoot. Past the month's allowance, triage
  pauses until the next month (mail still arrives), and a route answers `402 ALLOWANCE_REACHED`
  with `details.resetsAt`. Meetings on Free answer `402 PLAN_REQUIRED`.
- **A recording is counted when it ends**: starting one needs minutes left this month; its
  minutes are then counted whole, so one recording can pass the allowance, and the next cannot
  start.
- **Nothing is taken away.** A workspace that moves down or whose plan ends keeps everything it
  holds, over a cap or not, and only adds once back under. A workspace whose plan ends is Free:
  it reads and writes as before. There is no read-only state any more; `readOnly` in
  `GET /api/billing` is always `false` for clients from before plans, and `BILLING_INACTIVE` is
  never sent.
- **No trial.** Free is how a workspace tries Omni. `POST /api/billing/trial` answers `409`.
- **Two Free workspaces per person.** Creating a third workspace one owns on Free is refused
  (`PLAN_LIMIT`); paying for one makes room.
- **A Personal space is a workspace like any other** for billing: it is on Free and may move to a
  paid plan. (Removing the Personal space as a kind is the next layer of this work.)

## Where each limit is enforced

One decision, `planOf` in `@omni/db`: a subscription in good standing (`active`, `trialing`,
`past_due`) gives its plan, a paid one Omni cannot name is Team (the first plan), anything else is
Free. The Worker's `entitlements` adds the usage month; `requireCap` / `capRefusal` and
`gateMeter` / `requireMeter` are the guards. Each cap is counted in one place, `capUsage`.

| Limit | Checked at |
| --- | --- |
| Members | Better Auth's `beforeCreateInvitation`, `beforeAddMember`, `beforeAcceptInvitation`; `POST /workspace/invitations` before it makes the invitee's inbox; accepting a join request |
| Free workspaces per owner | Better Auth's `beforeCreateOrganization` |
| Inboxes | `provisionMailbox` (every Worker route that makes one); the mail service when a Gmail account lands in a workspace (`planCaps` on the connect call), so the cap is the landing workspace's |
| Domains | `POST /onboarding/domains`, unless the workspace already claims that domain |
| CRM records | `POST /crm/people`, `/crm/companies`, `/crm/deals`, and `crm_write` adds |
| Storage | `storageLimit`, as before, with the plan's GB |
| Triage | `gateTriage` in the AI job, only when a model would run |
| Meeting minutes | `POST /api/meetings` needs a paid plan with minutes left (`hasAllowance`); `POST /api/meetings/:id/stop` counts the recording's minutes, keyed by its audio file, so a retried stop counts once |
| Drafts and asks | `gateMeter` with `assist`, before the model runs: wired when drafted replies ship |

## Moving between plans

- Free to paid is Stripe Checkout (`POST /api/billing/checkout` with `plan` and `interval`).
- Paid to paid is `POST /api/billing/plan`: the subscription's plan item is swapped in place. A
  move up (a bigger plan, or yearly) is invoiced at once with proration and applies only once that
  invoice is paid (`payment_behavior: pending_if_incomplete`), so a failing card never unlocks the
  bigger plan; it answers `pending: true`. A move down is credited on the next invoice and applies
  at once. A yearly plan carries no metered price, so moving to one stops extra storage being
  billed. A subscription with a schedule is changed in the portal.
- Paid to Free is cancelling in the portal; the plan ends with its period.
- Stripe is the authority: the webhook and the daily reconcile map each subscription's price to
  its plan, so a change made in Stripe's dashboard or portal lands too.

## Stripe

One product per paid plan, each with a monthly and an optional yearly price; extra storage is
its own metered price on a Billing Meter. Config is ids only: `STRIPE_PRICE_MONTHLY` /
`STRIPE_PRICE_YEARLY` (Team, the names from before there were tiers),
`STRIPE_PRICE_BUSINESS_MONTHLY` / `STRIPE_PRICE_BUSINESS_YEARLY`, and the storage pair
(`docs/self-hosting.md`). With no `STRIPE_SECRET_KEY` there is no plan and no limit.

## Not yet

- The web and iOS screens: plan picker, usage meters, upgrade prompts on `402`.
- The `assist` meter has no caller until drafted replies ship; it must call `gateMeter` before
  the model runs.
- Disputes, refunds and early fraud warnings from Stripe are not handled yet.
- Removing Personal spaces as a kind of workspace (the next layer).

## Plan

1. **Plans and limits** (this layer): catalog, usage meters, guards, tiers in Stripe, moves
   between plans, lapsed workspaces on Free.
2. **One kind of workspace**: remove every Personal-space difference from the backend.
3. **Web and iOS**: plan, usage and upgrade screens; no more Personal-space hiding.

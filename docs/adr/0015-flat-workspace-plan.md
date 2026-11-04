# 0015: One flat plan per workspace, metered only by AI triage

Date: 2026-11-04 · Status: accepted · Amends: spec v1 "Non-goals" (billing), "Path to SaaS"

## Context

Omni exists so small teams get one inbox without paying per seat. Most team mail tools charge per
person, and per inbox or per domain is the same thing in disguise: every inbox belongs to a
person (a shared inbox is a team of people), and domains are free to add. Pricing on any of the
three would punish exactly the teams Omni is for.

What actually grows with use is AI. Mail hosting is flat (Purelymail), the Worker and database
cost the same at our scale whether a workspace has 3 people or 30, but every triaged email is a
model call. The spec already caps AI per day (`ai_usage`, `AI_DAILY_TOKEN_CAP`) to protect us; a
plan needs a limit a customer can read.

The spec names the tool: Stripe through Better Auth's Stripe plugin. Omni is also built to be
self-hosted, and a self-hoster owes us nothing.

## Decision

**One paid plan, Omnipresent: a flat price per workspace** (a Better Auth organization, ADR 0008), billed
monthly or yearly (the yearly price is usually discounted), with an optional free trial. People,
inboxes (personal and shared) and domains are unlimited. Prices live in Stripe; Omni's config
holds only their ids (`STRIPE_PRICE_MONTHLY`, optional `STRIPE_PRICE_YEARLY`), the trial length
(`BILLING_TRIAL_DAYS`) and the allowance (`BILLING_TRIAGE_ALLOWANCE`). No amount is in code. The plan's internal key is `omnipresent`; the name customers see
is the Stripe product's.

**The only limit is a monthly allowance of AI-triaged emails.** An email counts when a model is
asked to triage it: one row in `triage_usage` per (workspace, usage month, message), taken
before the model call under a per-workspace advisory lock, so concurrent jobs cannot overshoot and
a retried or redelivered job counts nothing new. The wordless-reply rule files threads without a
model and never counts. The usage month is the subscription's own period for a monthly plan; a
yearly plan's allowance resets monthly, stepped from its period start the way Stripe steps months
(`usagePeriod` in `@omni/ai`). The count resets because the next period is a new key.

**Past the allowance, nothing is lost or blocked.** Mail keeps syncing, reading, searching and
sending. New mail is simply not AI-triaged: the thread records `triage_paused_until` (the end of
the usage month), which the thread API returns and `GET /api/billing` repeats as
`triage.pausedUntil`, so the inbox can say "AI triage paused until <date>". A thread that went
untriaged is triaged by its next job (its next message) after the reset. Summaries keep their
existing daily token cap.

**An unpaid workspace is read-only, and its mail still syncs.** A workspace with a subscription
`active`, `trialing` or `past_due` (Stripe's grace while it retries a card) is in good standing.
Anything else, including never having subscribed, a canceled plan and a trial that ended without
a card, is read-only: mail syncs and every read works (inbox, threads, search, attachments), but
mail writes (send, reply, archive, move, read state, done, defer) answer `402` with code
`BILLING_INACTIVE`, and no AI runs. Setup, members, invitations and billing stay open so an owner
can always fix it. Nothing is deleted; subscribing again restores everything at once.

**Every new workspace starts on a free trial, during setup.** Where billing is on, onboarding has
a plan page after mailboxes and before invitations: pick monthly or yearly (at Stripe's own
prices) and press "Start free trial". The trial starts there and then (`POST /api/billing/trial`
creates the workspace's Stripe customer and a trialing subscription, and writes its row at once),
with no card and no Stripe page, and setup moves on; a card is due before the trial ends. A
workspace that has had its trial, a person who already started one for another workspace, or a
deployment with no trial, pays on Stripe's Checkout instead, which returns to onboarding. The page shows only while the workspace has no plan, and is passed
over otherwise: its state is read from the subscription each time, not saved as a setup step, so
it follows Stripe. `POST /api/onboarding/complete` answers `402 BILLING_REQUIRED` without a plan in
good standing, so invitations go out only from a workspace that has one. Self-hosted installs
without billing keep the four pages they had.

**The trial needs no card.** A trial that ends without a payment method cancels
(`trial_settings.end_behavior`), which makes the workspace read-only.

**One trial per workspace, and one per account, ever.** A workspace that had any subscription
with a trial gets no other. The person who starts a trial also uses up their own: `trial_claims`
holds one row per trial, unique on the workspace and on the account, taken before Stripe is
called, so two requests at once (two tabs, two new workspaces) cannot both start one. It has no
foreign keys, so deleting or leaving the workspace does not hand the trial back. Without this, one
person could create workspace after workspace, each on a new free trial; the AI allowance is per
workspace, so nothing else would stop it. Checkout never grants a trial (the plugin's `freeTrial`
is off: its rule is per workspace only); it is for paying, with
`payment_method_collection: "if_required"`, so a 100%-off promotion code needs no card either.

**Stripe's webhook is applied once and in order.** It is verified with Stripe's signature by the
Stripe SDK. Better Auth's plugin writes each event's snapshot as-is, and Stripe neither delivers
in order nor only once, so the Worker records every applied event in `stripe_events` and, in
front of the plugin, skips an event it has seen (`duplicate`) or one older than an event already
applied to the same object (`stale`). Replaying any event changes nothing.

**One paid subscription per workspace.** Opening Checkout expires the workspace customer's other
open Checkout sessions, so two tabs or two admins cannot both subscribe. If two still complete
(one paid while the next was opened), the webhook keeps the oldest paid subscription in Stripe
and cancels the rest at once, logging each at error level with its latest invoice for a person to
refund; nothing is refunded automatically. The survivor is chosen from Stripe's current state, so
a replayed event cancels nothing more.

**Endpoints.** `GET /api/billing` (plan, read-only state, triage usage), `POST
/api/billing/checkout` and `POST /api/billing/portal` (owners and admins; always the active
workspace) on the Worker, and Stripe's webhook at `/api/auth/stripe/webhook`. The plugin's own
`POST /api/auth/subscription/*` routes are closed: they would let a person subscribe for
themselves instead of their workspace.

**Cards and invoices.** Owners and admins see the workspace's saved cards and invoices in the
app, read from Stripe for the workspace's own customer (`GET /api/billing/cards`,
`GET /api/billing/invoices`); members get `403`, and with billing off both answer `404`. A card is
added with a SetupIntent (`POST /api/billing/cards/setup`) that Stripe.js confirms in the browser,
so card numbers never reach Omni; `POST /api/billing/cards` then lists it and, when the workspace
has no card being charged, makes it the default (a trial started with no card would otherwise
cancel at its end). The default card is set on the customer and on every live subscription,
because Checkout sets a subscription's own default, which wins over the customer's
(`POST /api/billing/cards/:id/default`). `DELETE /api/billing/cards/:id` refuses (`409`) to remove
the last card while a plan will still charge it; removing the default card moves the plan onto
the newest other card first, since Stripe would otherwise leave the renewal with nothing to
charge. Adding a card in the app needs the optional `STRIPE_PUBLISHABLE_KEY`; without it the add
row opens the customer portal instead.

**Billing is optional.** Without `STRIPE_SECRET_KEY` the Stripe plugin is not loaded, the webhook
and checkout answer `404`, `GET /api/billing` answers `{ "enabled": false }`, and nothing is
limited or gated: a self-hosted install runs exactly as before. Setting the key without the
webhook secret, the monthly price or the allowance stops the Worker at startup, naming what is
missing.

## Consequences

- New tables: `subscriptions` (from the plugin, `org_id` keyed), `triage_usage`, `stripe_events`,
  `trial_claims` (no foreign keys, so a trial outlives its workspace);
  new columns `organizations.stripe_customer_id`, `users.stripe_customer_id` (the plugin's; unused
  since customers are workspaces) and `threads.triage_paused_until`. All additive.
- An email that went untriaged past the allowance is not re-queued at the reset; its thread is
  triaged when its next message arrives. Re-queuing would spend the new month on old mail.
- The plugin logs and swallows its own handler errors and answers `200`, so a handler failure is
  recorded as applied. The handlers it runs for these events make no Stripe call except
  `checkout.session.completed`, which reads the subscription back; the `customer.subscription.*`
  events that follow carry the same state. The duplicate check runs after the plugin's handler,
  outside its error swallowing, so a failed cancel fails the webhook and Stripe retries it. It
  calls Stripe after every completed Checkout, and after a subscription event only when the
  workspace's own rows show two paid subscriptions.
- Because a webhook can still be missed (an outage past Stripe's retries, a swallowed handler
  error, an event before the workspace existed), a daily cron (`47 3 * * *`,
  `apps/worker/src/billing-reconcile.ts`) reads every workspace customer's subscriptions back
  from Stripe and writes the same fields the plugin's handlers write: it updates drifted rows,
  links a checkout row that never learned its Stripe id (by the `subscriptionId` metadata the
  plugin sets), and creates rows for subscriptions Omni never heard of. Canceled rows with
  `ended_at` are final and skipped. It paces Stripe calls to 10 a second, logs one
  `billing.reconciled` line (checked, changed, created, errors), and does nothing with billing
  off. A drifted workspace is therefore wrong for a day at most.
- Seats, metered prices and per-inbox add-ons are deliberately absent. Changing the price is a
  new Stripe price id in config; changing the allowance is one variable.
- Live Stripe products and production keys are created by a founder, not by code or CI.

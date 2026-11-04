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

**The trial needs no card.** Checkout uses `payment_method_collection: "if_required"`, and a
trial that ends without a payment method cancels (`trial_settings.end_behavior`), which makes the
workspace read-only. The plugin grants a trial once per workspace.

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

**Billing is optional.** Without `STRIPE_SECRET_KEY` the Stripe plugin is not loaded, the webhook
and checkout answer `404`, `GET /api/billing` answers `{ "enabled": false }`, and nothing is
limited or gated: a self-hosted install runs exactly as before. Setting the key without the
webhook secret, the monthly price or the allowance stops the Worker at startup, naming what is
missing.

## Consequences

- New tables: `subscriptions` (from the plugin, `org_id` keyed), `triage_usage`, `stripe_events`;
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
- Seats, metered prices and per-inbox add-ons are deliberately absent. Changing the price is a
  new Stripe price id in config; changing the allowance is one variable.
- Live Stripe products and production keys are created by a founder, not by code or CI.

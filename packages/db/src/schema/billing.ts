// Platform (ADR 0035): billing's own rows (ADR 0015): Stripe events applied, trials claimed, and
// AI triage counted against the plan.
import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { organizations } from "./auth.ts";
import { orgId, timestamptz, createdAt } from "./columns.ts";

/**
 * One row per AI-triaged email per workspace per usage month (ADR 0015): the count is the rows.
 * Keyed on the message, so a retried or redelivered job never counts twice. No foreign key to
 * `messages`: an email re-synced under a new id was still triaged once.
 */
export const triageUsage = pgTable(
  "triage_usage",
  {
    orgId: orgId(),
    /** Start of the usage month the email counts toward. */
    periodStart: timestamptz("period_start").notNull(),
    messageId: text("message_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.periodStart, t.messageId] })],
);

/**
 * Stripe webhook events already applied. A replay of one is a no-op, and an event older than one
 * already applied to the same object is skipped, since Stripe does not deliver in order.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    /** Stripe's event id (`evt_...`). */
    id: text("id").primaryKey(),
    /** The workspace the event is about, when its metadata names one. */
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** The event's object (`sub_...`, `cs_...`). */
    objectId: text("object_id"),
    /** When Stripe created the event. */
    eventCreatedAt: timestamptz("event_created_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("stripe_events_object_idx").on(t.objectId, t.eventCreatedAt)],
);

/**
 * Free trials granted, and to whom: one per workspace and one per account, ever (ADR 0015). The
 * person who starts a trial uses up their own, so a new workspace of theirs pays. No foreign
 * keys: deleting the workspace or leaving it must not hand the trial back.
 */
export const trialClaims = pgTable("trial_claims", {
  /** The workspace the trial is for. */
  orgId: text("org_id").primaryKey(),
  /** The account that started it. */
  userId: text("user_id").notNull().unique(),
  createdAt: createdAt(),
});

// Helpdesk (ADR 0021). Postgres holds the workflow; IMAP stays the source of truth for mail, so
// none of these rows is derived from a mailbox sync, and a full re-sync leaves them alone.

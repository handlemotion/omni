import { index, integer, pgEnum, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { organizations } from "./auth.ts";
import { orgId, timestamptz, createdAt } from "./columns.ts";

/**
 * One row per AI-triaged email per workspace per usage month: the count is the rows.
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
 * Free trials granted, and to whom: one per workspace and one per account, ever. The
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

/** What a usage month counts, per workspace: `METERS` in `@omni/contracts`. */
export const usageMeter = pgEnum("usage_meter", ["triage", "assist", "meeting_minutes"]);

/**
 * One row per costly thing done for a workspace in a usage month: an email triaged, a reply
 * drafted, a recording's minutes. Keyed on what it was done to, so a retried or redelivered job
 * never counts twice; the month's use is the sum of `amount`. Supersedes `triage_usage`, which
 * is still counted for the month it was written in.
 */
export const usageClaims = pgTable(
  "usage_claims",
  {
    orgId: orgId(),
    /** Start of the usage month: the subscription's period, or a calendar month (UTC) on Free. */
    periodStart: timestamptz("period_start").notNull(),
    meter: usageMeter("meter").notNull(),
    /** What was used up: a message id, a draft's thread and request, a recording id. */
    key: text("key").notNull(),
    amount: integer("amount").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.periodStart, t.meter, t.key] })],
);

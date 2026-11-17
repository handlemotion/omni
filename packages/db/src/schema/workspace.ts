import { index, jsonb, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { members, organizations } from "./auth.ts";
import { id, orgId, createdAt, updatedAt } from "./columns.ts";

/**
 * How far an organization's setup got, in order. Postgres compares enum values by this order,
 * so `greatest()` keeps whichever step is further along.
 */
export const setupStep = pgEnum("setup_step", [
  "created",
  "domain_added",
  "dns_verified",
  "mailboxes_created",
  "invites_sent",
  "complete",
]);

/**
 * Onboarding progress per organization (resumable setup). One row per org, written the first
 * time a setup step succeeds; it only ever moves forward. An org with no row (made by the
 * `org:create` CLI, or before this table) counts as `complete` once it has a mailbox and as
 * `created` before that (`orgSetupStep`).
 */
export const orgSetup = pgTable("org_setup", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  step: setupStep("step").notNull().default("created"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Who did what to an org's shared setup, newest last. Append-only. `action` is dotted
 * (`domain.claimed`, `domain.verified`, ...); `subject` is what it happened to (the domain).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: orgId(),
    /** Null for the system (a scheduled DNS check). */
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_org_subject_idx").on(t.orgId, t.subject, t.createdAt)],
);

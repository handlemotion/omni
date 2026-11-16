// SLA targets and clocks (ADR 0023). A conversation carries two clocks: `response_clock_at`, when
// the customer started waiting for the reply we owe, and `resolution_clock_at`, when its current
// open stretch began. Its due times are those clocks plus the inbox's targets for its priority,
// counted in business hours. The workflow in `conversations.ts` starts and stops the clocks; this
// file turns them into due times, holds the per-inbox settings, and finds the alerts the minute
// cron owes.
import type { SlaTarget } from "@omni/contracts";
import { addBusinessMinutes, type BusinessSchedule } from "@omni/mail-core/business-hours";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { SLA_AT_RISK_MINUTES } from "./queries.ts";
import {
  businessHours,
  conversationEvents,
  conversationPriority,
  mailboxAccess,
  mailboxes,
  members,
  notifications,
  slaDueAt,
  slaPolicies,
  threads,
  type BusinessHoursWindow,
} from "../schema/index.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;
type Priority = (typeof conversationPriority.enumValues)[number];

export interface SlaClocks {
  priority: Priority;
  firstRespondedAt: Date | null;
  responseClockAt: Date | null;
  resolutionClockAt: Date | null;
}

export interface DueTimes {
  firstResponseDueAt: Date | null;
  nextResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
}

interface Targets {
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  /** Null: every minute counts. */
  schedule: BusinessSchedule | null;
}

/** The inbox's targets for this priority, or null when it has none. */
async function targetsFor(tx: Executor, mailboxId: string, priority: Priority) {
  const [row] = await tx
    .select({
      firstResponseMinutes: slaPolicies.firstResponseMinutes,
      nextResponseMinutes: slaPolicies.nextResponseMinutes,
      resolutionMinutes: slaPolicies.resolutionMinutes,
      businessHoursOnly: slaPolicies.businessHoursOnly,
      timezone: businessHours.timezone,
      windows: businessHours.windows,
      holidays: businessHours.holidays,
    })
    .from(slaPolicies)
    .leftJoin(businessHours, eq(businessHours.mailboxId, slaPolicies.mailboxId))
    .where(and(eq(slaPolicies.mailboxId, mailboxId), eq(slaPolicies.priority, priority)));
  if (!row) return null;
  return {
    firstResponseMinutes: row.firstResponseMinutes,
    nextResponseMinutes: row.nextResponseMinutes,
    resolutionMinutes: row.resolutionMinutes,
    schedule:
      row.businessHoursOnly && row.timezone
        ? { timezone: row.timezone, windows: row.windows ?? [], holidays: row.holidays ?? [] }
        : null,
  } satisfies Targets;
}

function due(clock: Date | null, minutes: number | null, schedule: BusinessSchedule | null) {
  return clock && minutes !== null ? addBusinessMinutes(clock, minutes, schedule) : null;
}

/** Due times from the clocks: first response until we first reply, next response after it. */
export function dueTimes(clocks: SlaClocks, targets: Targets | null): DueTimes {
  if (!targets) return { firstResponseDueAt: null, nextResponseDueAt: null, resolutionDueAt: null };
  const { schedule } = targets;
  return {
    firstResponseDueAt: clocks.firstRespondedAt
      ? null
      : due(clocks.responseClockAt, targets.firstResponseMinutes, schedule),
    nextResponseDueAt: clocks.firstRespondedAt
      ? due(clocks.responseClockAt, targets.nextResponseMinutes, schedule)
      : null,
    resolutionDueAt: due(clocks.resolutionClockAt, targets.resolutionMinutes, schedule),
  };
}

/**
 * Sets the conversation's clocks (fields left out stay as they are) and recomputes its due
 * times. Call inside the transaction that locked the row. Returns the row with both applied.
 */
export async function setSlaClocks<
  Row extends SlaClocks & DueTimes & { id: string; mailboxId: string },
>(
  tx: Tx,
  row: Row,
  clocks: Partial<Pick<SlaClocks, "responseClockAt" | "resolutionClockAt">> = {},
): Promise<Row> {
  const next = { ...row, ...clocks };
  const anyClock = next.responseClockAt || next.resolutionClockAt;
  const times = anyClock
    ? dueTimes(next, await targetsFor(tx, row.mailboxId, next.priority))
    : dueTimes(next, null);
  const updated = { ...next, ...times };
  const same =
    sameTime(row.responseClockAt, updated.responseClockAt) &&
    sameTime(row.resolutionClockAt, updated.resolutionClockAt) &&
    sameTime(row.firstResponseDueAt, updated.firstResponseDueAt) &&
    sameTime(row.nextResponseDueAt, updated.nextResponseDueAt) &&
    sameTime(row.resolutionDueAt, updated.resolutionDueAt);
  if (!same) {
    await tx
      .update(threads)
      .set({
        responseClockAt: updated.responseClockAt,
        resolutionClockAt: updated.resolutionClockAt,
        ...times,
      })
      .where(eq(threads.id, row.id));
  }
  return updated;
}

function sameTime(a: Date | null, b: Date | null) {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/**
 * Recomputes the due times of every conversation in the inbox with a running clock, after its
 * targets or hours changed. A row the workflow changed in between is left to the workflow (its
 * clocks or priority no longer match), so this never writes a stale due time.
 */
export async function refreshInboxDueTimes(db: Executor, mailboxId: string) {
  const rows = await db
    .select({
      id: threads.id,
      priority: threads.priority,
      firstRespondedAt: threads.firstRespondedAt,
      responseClockAt: threads.responseClockAt,
      resolutionClockAt: threads.resolutionClockAt,
    })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, mailboxId),
        ne(threads.status, "resolved"),
        or(isNotNull(threads.responseClockAt), isNotNull(threads.resolutionClockAt)),
      ),
    );
  const targets = new Map<Priority, Targets | null>();
  for (const priority of conversationPriority.enumValues) {
    targets.set(priority, await targetsFor(db, mailboxId, priority));
  }
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500).map((row) => {
      const times = dueTimes(row, targets.get(row.priority) ?? null);
      return sql`(${row.id}, ${row.priority}, ${iso(row.firstRespondedAt)}::timestamptz,
        ${iso(row.responseClockAt)}::timestamptz, ${iso(row.resolutionClockAt)}::timestamptz,
        ${iso(times.firstResponseDueAt)}::timestamptz, ${iso(times.nextResponseDueAt)}::timestamptz,
        ${iso(times.resolutionDueAt)}::timestamptz)`;
    });
    await db.execute(sql`
      update ${threads} as t set
        first_response_due_at = v.first_due,
        next_response_due_at = v.next_due,
        resolution_due_at = v.resolution_due
      from (values ${sql.join(values, sql`, `)})
        as v(id, priority, responded, response_clock, resolution_clock, first_due, next_due, resolution_due)
      where t.id = v.id
        and t.priority::text = v.priority
        and t.first_responded_at is not distinct from v.responded
        and t.response_clock_at is not distinct from v.response_clock
        and t.resolution_clock_at is not distinct from v.resolution_clock`);
  }
  return rows.length;
}

// Settings: one inbox's targets per priority and its business hours. Owners and admins of the
// inbox's org change them (the route checks the role); the mailbox must be a shared one in it.

/**
 * Changes a shared inbox's settings with `change`, then recomputes its due times, in one
 * transaction holding the mailbox row: concurrent changes run one after the other, so the due
 * times always match the settings that end up stored. False when it is not a shared inbox of
 * the org.
 */
async function changeInboxSettings(
  db: Db,
  orgId: string,
  mailboxId: string,
  change: (tx: Tx) => Promise<unknown>,
) {
  return db.transaction(async (tx) => {
    // No key update: it does not block the foreign-key checks of rows written for the inbox.
    const [row] = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId), eq(mailboxes.kind, "shared")),
      )
      .for("no key update");
    if (!row) return false;
    await change(tx);
    await refreshInboxDueTimes(tx, mailboxId);
    return true;
  });
}

export interface SlaPolicyInput {
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  businessHoursOnly: boolean;
}

/** Sets the inbox's targets for one priority. False when it is not a shared inbox of the org. */
export async function putSlaPolicy(
  db: Db,
  orgId: string,
  mailboxId: string,
  priority: Priority,
  input: SlaPolicyInput,
) {
  return changeInboxSettings(db, orgId, mailboxId, (tx) =>
    tx
      .insert(slaPolicies)
      .values({ id: uuidv7(), orgId, mailboxId, priority, ...input })
      .onConflictDoUpdate({
        target: [slaPolicies.mailboxId, slaPolicies.priority],
        set: { ...input, updatedAt: new Date() },
      }),
  );
}

/** Stops tracking one priority. False when it is not a shared inbox of the org. */
export async function deleteSlaPolicy(
  db: Db,
  orgId: string,
  mailboxId: string,
  priority: Priority,
) {
  return changeInboxSettings(db, orgId, mailboxId, (tx) =>
    tx
      .delete(slaPolicies)
      .where(and(eq(slaPolicies.mailboxId, mailboxId), eq(slaPolicies.priority, priority))),
  );
}

export interface BusinessHoursInput {
  timezone: string;
  windows: BusinessHoursWindow[];
  holidays: string[];
}

/** Sets when the inbox is staffed. False when it is not a shared inbox of the org. */
export async function putBusinessHours(
  db: Db,
  orgId: string,
  mailboxId: string,
  input: BusinessHoursInput,
) {
  return changeInboxSettings(db, orgId, mailboxId, (tx) =>
    tx
      .insert(businessHours)
      .values({ id: uuidv7(), orgId, mailboxId, ...input })
      .onConflictDoUpdate({
        target: businessHours.mailboxId,
        set: { ...input, updatedAt: new Date() },
      }),
  );
}

/** Back to always open. False when it is not a shared inbox of the org. */
export async function deleteBusinessHours(db: Db, orgId: string, mailboxId: string) {
  return changeInboxSettings(db, orgId, mailboxId, (tx) =>
    tx.delete(businessHours).where(eq(businessHours.mailboxId, mailboxId)),
  );
}

// Alerts: the minute cron's half. Each (conversation, target, due time) alerts at risk once and
// breached once; a new due time (a priority change, a new customer message) can alert again.

export interface SlaAlert {
  orgId: string;
  mailboxId: string;
  threadId: string;
  target: SlaTarget;
  kind: "sla_at_risk" | "sla_breached";
  dueAt: Date;
  /** Members who got a new notification. */
  notified: string[];
}

const TARGETS = [
  ["first_response", "firstResponseDueAt"],
  ["next_response", "nextResponseDueAt"],
  ["resolution", "resolutionDueAt"],
] as const;

const dueColumns = {
  first_response: threads.firstResponseDueAt,
  next_response: threads.nextResponseDueAt,
  resolution: threads.resolutionDueAt,
} as const;

function alertKey(kind: SlaAlert["kind"], target: SlaTarget, dueAt: Date) {
  return `${kind}:${target}:${dueAt.toISOString()}`;
}

/** Whether the alert for one due column is owed at `now` and not yet written, as SQL. */
function owedAlert(target: SlaTarget, column: AnyPgColumn, now: Date, horizon: Date) {
  const at = sql`${now.toISOString()}::timestamptz`;
  // Same text as alertKey: Date#toISOString is UTC with milliseconds.
  const key = sql`(case when ${column} <= ${at} then 'sla_breached' else 'sla_at_risk' end)
    || ${`:${target}:`} || to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  return sql`(${column} <= ${horizon.toISOString()}::timestamptz and not exists (
    select 1 from ${conversationEvents}
    where ${conversationEvents.threadId} = ${threads.id} and ${conversationEvents.dedupeKey} = ${key}
  ))`;
}

/**
 * Writes the at-risk and breached events (and notifications) owed at `now`. Idempotent: an alert
 * already written is skipped, so a late or doubled run alerts once. Only open conversations
 * alert; a pending or snoozed one alerts when it opens again if it is still late.
 */
export async function emitSlaAlerts(db: Db, now: Date, limit = 1000): Promise<SlaAlert[]> {
  const horizon = new Date(now.getTime() + SLA_AT_RISK_MINUTES * 60_000);
  // Newest due first: long-breached conversations sit at the end and cannot crowd out new alerts.
  const candidates = await db
    .select({
      id: threads.id,
      orgId: threads.orgId,
      mailboxId: threads.mailboxId,
      firstResponseDueAt: threads.firstResponseDueAt,
      nextResponseDueAt: threads.nextResponseDueAt,
      resolutionDueAt: threads.resolutionDueAt,
    })
    .from(threads)
    .where(
      and(
        eq(threads.status, "open"),
        sql`${slaDueAt(threads)} <= ${horizon.toISOString()}::timestamptz`,
        // Skip conversations whose alerts were all delivered before the limit, so a backlog of
        // already-alerted rows can never hide a newly owed alert.
        or(...TARGETS.map(([target, column]) => owedAlert(target, threads[column], now, horizon))),
      ),
    )
    .orderBy(sql`${slaDueAt(threads)} desc`)
    .limit(limit);

  const owed: {
    row: (typeof candidates)[number];
    target: SlaTarget;
    kind: SlaAlert["kind"];
    dueAt: Date;
    key: string;
  }[] = [];
  for (const row of candidates) {
    for (const [target, column] of TARGETS) {
      const dueAt = row[column];
      if (!dueAt || dueAt > horizon) continue;
      const kind = dueAt <= now ? "sla_breached" : "sla_at_risk";
      owed.push({ row, target, kind, dueAt, key: alertKey(kind, target, dueAt) });
    }
  }
  if (owed.length === 0) return [];
  const seen = new Set(
    (
      await db
        .select({ threadId: conversationEvents.threadId, key: conversationEvents.dedupeKey })
        .from(conversationEvents)
        .where(
          and(
            inArray(conversationEvents.threadId, [...new Set(owed.map((o) => o.row.id))]),
            inArray(conversationEvents.dedupeKey, [...new Set(owed.map((o) => o.key))]),
          ),
        )
    ).map((r) => `${r.threadId} ${r.key}`),
  );

  const alerts: SlaAlert[] = [];
  for (const alert of owed) {
    if (seen.has(`${alert.row.id} ${alert.key}`)) continue;
    const written = await db.transaction(async (tx) => {
      // Recheck under the row lock: an agent may have replied or resolved since the scan.
      const [row] = await tx
        .select({
          status: threads.status,
          assigneeMemberId: threads.assigneeMemberId,
          dueAt: dueColumns[alert.target],
        })
        .from(threads)
        .where(eq(threads.id, alert.row.id))
        .for("update");
      if (!row || row.status !== "open" || !row.dueAt) return null;
      if (row.dueAt.getTime() !== alert.dueAt.getTime()) return null;
      const [event] = await tx
        .insert(conversationEvents)
        .values({
          id: uuidv7(),
          orgId: alert.row.orgId,
          mailboxId: alert.row.mailboxId,
          threadId: alert.row.id,
          actorMemberId: null,
          kind: alert.kind,
          data: { target: alert.target, dueAt: alert.dueAt.toISOString() },
          dedupeKey: alert.key,
        })
        .onConflictDoNothing()
        .returning({ id: conversationEvents.id });
      if (!event) return null;
      // The assignee owns it; nobody does yet, so the whole inbox hears.
      const recipients = row.assigneeMemberId
        ? [row.assigneeMemberId]
        : (
            await tx
              .select({ id: mailboxAccess.memberId })
              .from(mailboxAccess)
              .innerJoin(
                members,
                and(
                  eq(members.id, mailboxAccess.memberId),
                  eq(members.organizationId, alert.row.orgId),
                ),
              )
              .where(eq(mailboxAccess.mailboxId, alert.row.mailboxId))
          ).map((m) => m.id);
      if (recipients.length === 0) return [];
      const rows = await tx
        .insert(notifications)
        .values(
          recipients.map((memberId) => ({
            id: uuidv7(),
            orgId: alert.row.orgId,
            memberId,
            kind: alert.kind,
            threadId: alert.row.id,
            data: {
              mailboxId: alert.row.mailboxId,
              target: alert.target,
              dueAt: alert.dueAt.toISOString(),
            },
            dedupeKey: `${alert.row.id}:${alert.key}`,
          })),
        )
        .onConflictDoNothing()
        .returning({ memberId: notifications.memberId });
      return rows.map((r) => r.memberId);
    });
    if (written === null) continue;
    alerts.push({
      orgId: alert.row.orgId,
      mailboxId: alert.row.mailboxId,
      threadId: alert.row.id,
      target: alert.target,
      kind: alert.kind,
      dueAt: alert.dueAt,
      notified: written,
    });
  }
  return alerts;
}

// The helpdesk's clock, run by the every-minute cron (ADR 0021, ADR 0023): wakes snoozed
// conversations whose time has come and raises SLA alerts. Every step is idempotent: the status
// rule wakes a conversation only while its current snooze is over, and each alert is keyed by its
// target and due time, so a late or doubled run changes nothing twice.
import { applyConversationChange, dueSnoozes, emitSlaAlerts, type Db } from "@omni/db";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";
import { announceSla, fanOut, notifyMembers } from "./realtime.ts";

export async function wakeSnoozed(scope: {
  env: Env;
  db: Db;
  config: Config;
  log: Logger;
  now?: Date;
}) {
  const now = scope.now ?? new Date();
  const due = await dueSnoozes(scope.db, now);
  const changed = new Map<string, Set<string>>();
  for (const thread of due) {
    const result = await applyConversationChange(scope.db, {
      threadId: thread.id,
      actorMemberId: null,
      change: { type: "snooze_expired" },
      now,
    });
    if (result.ok && result.changed) {
      const threads = changed.get(thread.mailboxId) ?? new Set();
      threads.add(thread.id);
      changed.set(thread.mailboxId, threads);
    }
  }
  if (changed.size) await fanOut(scope.env, scope.db, scope.config, changed);
  return { due: due.length, woken: [...changed.values()].reduce((n, s) => n + s.size, 0) };
}

/**
 * Writes the SLA at-risk and breached events owed now, notifies the assignee (or the whole inbox
 * when nobody owns it), and tells the inbox in realtime.
 */
export async function alertSlas(scope: { env: Env; db: Db; now?: Date }) {
  const alerts = await emitSlaAlerts(scope.db, scope.now ?? new Date());
  for (const alert of alerts) {
    await Promise.all([
      announceSla(scope.env, scope.db, alert),
      notifyMembers(scope.env, scope.db, {
        orgId: alert.orgId,
        threadId: alert.threadId,
        memberIds: alert.notified,
        kind: alert.kind,
      }),
    ]);
  }
  return {
    atRisk: alerts.filter((a) => a.kind === "sla_at_risk").length,
    breached: alerts.filter((a) => a.kind === "sla_breached").length,
  };
}

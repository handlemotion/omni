// The helpdesk's clock, run by the every-minute cron (ADR 0021): wakes snoozed conversations whose
// time has come. Every step is idempotent: the status rule wakes a conversation only while its
// current snooze is over, so a late or doubled run changes nothing twice.
import { applyConversationChange, dueSnoozes, type Db } from "@omni/db";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";
import { fanOut } from "./realtime.ts";

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

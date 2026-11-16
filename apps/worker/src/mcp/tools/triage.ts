// `triage`: change many threads at once (ADR 0029). Each field sets an absolute value, so a
// retried call writes the same state. Every change acts as the person's member whose grant shows
// the thread, through the same functions the app's routes use, and answers per change: one bad
// thread id does not stop the rest.
import type { McpServer } from "@modelcontextprotocol/server";
import {
  applyConversationChange,
  LANES,
  PRIORITIES,
  resortThread,
  schema,
  type ConversationChange,
} from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "../../billing.ts";
import { pingMailService } from "../../mail-service.ts";
import { fanOut, notifyMembers } from "../../realtime.ts";
import {
  archiveThread,
  markRead,
  setTriage,
  type ThreadTargets,
  type ThreadWriter,
  type TriagePatch,
} from "../../thread-writes.ts";
import { result, toolError } from "../format.ts";
import { readsFor, type Reads } from "../scope.ts";
import { guarded, type ToolContext } from "../server.ts";

const MAX_CHANGES = 50;

const changeSchema = z.object({
  thread_id: z.string().min(1),
  done: z.boolean().optional().describe("Done for the person (comes back with new mail)."),
  later: z.boolean().optional().describe("Into or out of the person's Later."),
  read: z.boolean().optional(),
  archived: z.literal(true).optional().describe("Archive it (moves the mail out of the inbox)."),
  lane: z
    .enum(schema.triageBucket.enumValues)
    .optional()
    .describe("File it in a triage lane, as the person (overrides the AI)."),
  status: z
    .enum(["open", "resolved"])
    .optional()
    .describe("Shared inboxes: reopen or resolve the conversation."),
  assignee: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Shared inboxes: "me", a teammate\'s email, or null to unassign.'),
  priority: z.enum(PRIORITIES).optional().describe("Shared inboxes."),
  add_tags: z.array(z.string().min(1)).max(10).optional().describe("Shared inboxes: tag names."),
  remove_tags: z.array(z.string().min(1)).max(10).optional(),
});

type Change = z.infer<typeof changeSchema>;

const inputSchema = z.object({
  changes: z.array(changeSchema).min(1).max(MAX_CHANGES),
  workspace: z.string().min(1).optional(),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      thread_id: z.string(),
      ok: z.boolean(),
      applied: z.array(z.string()).describe("The fields that were applied."),
      error: z.string().optional(),
    }),
  ),
});

/** What one change did, for the result and the audit row. */
interface Outcome {
  applied: string[];
  error?: string;
}

interface Effects {
  /** Mailbox → threads whose open apps must refresh. */
  changed: Map<string, Set<string>>;
  queued: boolean;
}

const CONVERSATION_FIELDS = ["status", "assignee", "priority", "add_tags", "remove_tags"] as const;
const FAILURES: Record<string, string> = {
  not_found: "not found",
  personal_mailbox: "status, assignee, priority and tags are for shared inboxes",
  not_assignable: "that teammate cannot see this inbox",
  unknown_tag: "that tag is not one of this inbox's",
  assignee_changed: "a teammate assigned it first",
};

/** The thread as the change found it: which inbox, and how far its mail went. */
interface Found {
  mailboxId: string;
  lastMessageAt: Date;
}

/**
 * The outbox key for archiving: the thread and where its mail is now. Repeating the archive (a
 * retried call) queues nothing new until the mail has moved, e.g. back to the inbox in another
 * mail app, when it is queued again.
 */
async function archiveKey(threadId: string, targets: ThreadTargets) {
  const where = targets.map((t) => `${t.folder}:${t.uidValidity}:${t.uids.join(",")}`).join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${threadId}|${where}`),
  );
  return `mcp.archive.${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function conversationChanges(
  reads: Reads,
  member: { id: string },
  mailboxId: string,
  change: Change,
): Promise<{ changes: ConversationChange[] } | { error: string }> {
  const changes: ConversationChange[] = [];
  if (change.status) changes.push({ type: change.status === "resolved" ? "resolve" : "reopen" });
  if (change.priority) changes.push({ type: "priority", priority: change.priority });
  if (change.assignee !== undefined) {
    if (change.assignee === null) changes.push({ type: "assign", memberId: null });
    else if (change.assignee === "me") changes.push({ type: "assign", memberId: member.id });
    else {
      const people = (await reads.mailboxAssignees(mailboxId)) ?? [];
      const person = people.find((p) => p.email?.toLowerCase() === change.assignee!.toLowerCase());
      if (!person) return { error: `${change.assignee} cannot see this inbox` };
      changes.push({ type: "assign", memberId: person.memberId });
    }
  }
  const names = [...(change.add_tags ?? []), ...(change.remove_tags ?? [])];
  if (names.length) {
    const tags = (await reads.listTags(mailboxId)) ?? [];
    const idOf = (name: string) =>
      tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id;
    const unknown = names.filter((name) => !idOf(name));
    if (unknown.length) {
      return {
        error: `no tag ${unknown.join(", ")} in this inbox (${tags.map((t) => t.name).join(", ") || "it has none"})`,
      };
    }
    for (const name of change.add_tags ?? [])
      changes.push({ type: "tag", tagId: idOf(name)!, add: true });
    for (const name of change.remove_tags ?? [])
      changes.push({ type: "tag", tagId: idOf(name)!, add: false });
  }
  return { changes };
}

/** One thread being changed, as the member whose grant shows it. */
interface Target {
  threadId: string;
  member: { id: string; orgId: string };
  found: Found;
  writer: ThreadWriter;
  effects: Effects;
}

/** The person's own state: done, Later, read, lane, archived. Returns the fields applied. */
async function applyPersonal(context: ToolContext, target: Target, change: Change) {
  const { threadId, member, found, writer, effects } = target;
  const applied: string[] = [];
  // A fresh key per call, as for read below: on a Google account each change must reach Gmail
  // (ADR 0044), and a retried call queues the same flag twice, which is harmless.
  const sync = async (name: "done" | "later", patch: TriagePatch) => {
    const set = await setTriage(writer, threadId, patch, `mcp.${name}.${crypto.randomUUID()}`);
    if (set?.actionIds.length) effects.queued = true;
    applied.push(name);
  };
  if (change.done !== undefined) {
    // Done through the mail this call saw, as the app's Done does: a message that arrives
    // meanwhile stays in the Inbox.
    await sync(
      "done",
      change.done ? { doneThrough: found.lastMessageAt, later: false } : { doneThrough: null },
    );
  }
  if (change.later !== undefined) {
    await sync("later", change.later ? { later: true, doneThrough: null } : { later: false });
  }
  if (change.read !== undefined) {
    // A fresh key per call: read, unread, read again must each reach IMAP. A retried call queues
    // the same flag twice, which is harmless.
    const marked = await markRead(writer, threadId, change.read, `mcp.read.${crypto.randomUUID()}`);
    if (marked?.actionIds.length) effects.queued = true;
    applied.push("read");
  }
  if (change.lane) {
    await resortThread(context.db, member.id, threadId, change.lane);
    applied.push("lane");
  }
  if (change.archived) {
    const archived = await archiveThread(writer, threadId, (targets) =>
      archiveKey(threadId, targets),
    );
    if (archived?.actionIds.length) effects.queued = true;
    applied.push("archived");
  }
  return applied;
}

/** A shared conversation's status, assignee, priority and tags, through its workflow. */
async function applyConversation(
  context: ToolContext,
  reads: Reads,
  target: Target,
  change: Change,
): Promise<Outcome> {
  const { threadId, member, found, effects } = target;
  const planned = await conversationChanges(reads, member, found.mailboxId, change);
  if ("error" in planned) return { applied: [], error: planned.error };
  for (const conversationChange of planned.changes) {
    const outcome = await applyConversationChange(context.db, {
      threadId,
      actorMemberId: member.id,
      change: conversationChange,
      requestId: context.requestId,
    });
    if (!outcome.ok) return { applied: [], error: FAILURES[outcome.reason] ?? outcome.reason };
    if (outcome.queuedActions > 0) effects.queued = true;
    if (outcome.changed && outcome.notified.length) {
      context.waitUntil(
        notifyMembers(context.env, context.db, {
          orgId: outcome.conversation.orgId,
          threadId,
          memberIds: outcome.notified,
          kind: "assigned",
        }),
      );
    }
  }
  return { applied: CONVERSATION_FIELDS.filter((field) => change[field] !== undefined) };
}

async function applyOne(
  context: ToolContext,
  reads: Reads,
  change: Change,
  found: Found | undefined,
  effects: Effects,
  standing: Map<string, Promise<boolean>>,
): Promise<Outcome> {
  const member = found && (await reads.memberFor(change.thread_id));
  if (!found || !member) return { applied: [], error: "not a thread you can see" };
  const good =
    standing.get(member.orgId) ?? inGoodStanding(context.db, context.config, member.orgId);
  standing.set(member.orgId, good);
  if (!(await good)) {
    return { applied: [], error: "this workspace is read-only until its plan is paid" };
  }
  const target: Target = {
    threadId: change.thread_id,
    member,
    found,
    writer: { db: context.db, memberId: member.id, requestId: context.requestId },
    effects,
  };
  const applied = await applyPersonal(context, target, change);
  let error: string | undefined;
  if (CONVERSATION_FIELDS.some((field) => change[field] !== undefined)) {
    const outcome = await applyConversation(context, reads, target, change);
    applied.push(...outcome.applied);
    error = outcome.error;
  }
  // Whatever was applied is announced and audited, even when a later field failed.
  if (applied.length) {
    const threads = effects.changed.get(found.mailboxId) ?? new Set();
    effects.changed.set(found.mailboxId, threads.add(change.thread_id));
    await context.db.insert(schema.auditEvents).values({
      orgId: member.orgId,
      actorMemberId: member.id,
      action: "mcp.triage",
      subject: change.thread_id,
      data: { via: "mcp", clientId: context.caller.clientId, applied },
    });
  }
  return error ? { applied, error } : { applied };
}

async function triage(context: ToolContext, input: z.infer<typeof inputSchema>) {
  // Each change counts toward the per-person action limit, as it would one by one in the app.
  const wait = await context.rateLimit("actions", input.changes.length);
  if (wait) return toolError(`Too many changes. Try again in ${wait} seconds.`);
  const scoped = readsFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const effects: Effects = { changed: new Map(), queued: false };
  const standing = new Map<string, Promise<boolean>>();
  // Every thread once, in three queries: its inbox and latest mail, and whether it is visible.
  const threads = await scoped.reads.getThreads(input.changes.map((c) => c.thread_id));
  const found = new Map(
    threads.map((t) => [t.id, { mailboxId: t.mailboxId, lastMessageAt: t.lastMessageAt }]),
  );
  const results = [];
  // One at a time: changes to one thread may depend on each other's order (done, then archive).
  for (const change of input.changes) {
    const outcome = await applyOne(
      context,
      scoped.reads,
      change,
      found.get(change.thread_id),
      effects,
      standing,
    );
    results.push({
      thread_id: change.thread_id,
      ok: outcome.error === undefined,
      applied: outcome.applied,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  if (effects.queued) context.waitUntil(pingMailService(context));
  if (effects.changed.size) {
    context.waitUntil(fanOut(context.env, context.db, context.config, effects.changed));
  }
  return result({ results });
}

export function registerTriage(server: McpServer, context: ToolContext) {
  server.registerTool(
    "triage",
    {
      title: "Triage threads",
      description: `Change up to ${MAX_CHANGES} threads in one call, each by id: done, later, read, archived (true only), lane (${LANES.filter((l) => l !== "unsure").join(", ")}), and for shared inboxes status (open/resolved), assignee ("me", a teammate's email, or null), priority and tags by name. Every value is absolute, so repeating a call is safe. Each change answers on its own. Nothing is sent or deleted.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "triage", () => triage(context, input)),
  );
}

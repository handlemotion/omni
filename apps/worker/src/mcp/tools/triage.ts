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

interface Outcome {
  applied: string[];
  error?: string;
}

interface Effects {
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

interface Found {
  mailboxId: string;
  lastMessageAt: Date;
}

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
) {
  const changes: ConversationChange[] = [];
  if (change.status) changes.push({ type: change.status === "resolved" ? "resolve" : "reopen" });
  if (change.priority) changes.push({ type: "priority", priority: change.priority });
  if (change.assignee !== undefined) {
    if (change.assignee === null) changes.push({ type: "assign", memberId: null });
    else if (change.assignee === "me") changes.push({ type: "assign", memberId: member.id });
    else {
      const people = (await reads.mailboxAssignees(mailboxId)) ?? [];
      const person = people.find((p) => p.email?.toLowerCase() === change.assignee!.toLowerCase());
      if (!person)
        return { error: `${change.assignee} cannot see this inbox` } satisfies
          | { changes: ConversationChange[] }
          | { error: string };
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
      } satisfies { changes: ConversationChange[] } | { error: string };
    }
    for (const name of change.add_tags ?? [])
      changes.push({ type: "tag", tagId: idOf(name)!, add: true });
    for (const name of change.remove_tags ?? [])
      changes.push({ type: "tag", tagId: idOf(name)!, add: false });
  }
  return { changes } satisfies { changes: ConversationChange[] } | { error: string };
}

interface Target {
  threadId: string;
  member: { id: string; orgId: string };
  found: Found;
  writer: ThreadWriter;
  effects: Effects;
}

async function applyPersonal(context: ToolContext, target: Target, change: Change) {
  const { threadId, member, found, writer, effects } = target;
  const applied: string[] = [];
  const sync = async (name: "done" | "later", patch: TriagePatch) => {
    const set = await setTriage(writer, threadId, patch, `mcp.${name}.${crypto.randomUUID()}`);
    if (set?.actionIds.length) effects.queued = true;
    applied.push(name);
  };
  if (change.done !== undefined) {
    await sync(
      "done",
      change.done ? { doneThrough: found.lastMessageAt, later: false } : { doneThrough: null },
    );
  }
  if (change.later !== undefined) {
    await sync("later", change.later ? { later: true, doneThrough: null } : { later: false });
  }
  if (change.read !== undefined) {
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

const applyConversation: (
  context: ToolContext,
  reads: Reads,
  target: Target,
  change: Change,
) => Promise<Outcome> = async (context, reads, target, change) => {
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
};

async function applyOne(
  context: ToolContext,
  reads: Reads,
  change: Change,
  found: Found | undefined,
  effects: Effects,
) {
  const member = found && (await reads.memberFor(change.thread_id));
  if (!found || !member) {
    const result: Outcome = { applied: [], error: "not a thread you can see" };
    return result;
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
  const outcome: Outcome = error ? { applied, error } : { applied };
  return outcome;
}

async function triage(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const wait = await context.rateLimit("actions", input.changes.length);
  if (wait) return toolError(`Too many changes. Try again in ${wait} seconds.`);
  const scoped = readsFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const effects: Effects = { changed: new Map(), queued: false };
  const threads = await scoped.reads.getThreads(input.changes.map((c) => c.thread_id));
  const found = new Map(
    threads.map((t) => [t.id, { mailboxId: t.mailboxId, lastMessageAt: t.lastMessageAt }]),
  );
  const results = [];
  for (const change of input.changes) {
    const outcome = await applyOne(
      context,
      scoped.reads,
      change,
      found.get(change.thread_id),
      effects,
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

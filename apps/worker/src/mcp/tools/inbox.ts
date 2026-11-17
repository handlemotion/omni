import { listUserWorkspaces, schema } from "@omni/db";
import type { McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { result, threadSummary, threadSummarySchema, threadUrl, toolError } from "../format.ts";
import { readsFor } from "../scope.ts";
import { guarded, type ToolContext } from "../server.ts";

const laneCounts = z.object({
  needs_reply: z.number(),
  unsure: z.number(),
  waiting_on_them: z.number(),
  fyi: z.number(),
  noise: z.number(),
});

const outputSchema = z.object({
  now: z.string(),
  me: z.object({ name: z.string(), email: z.string() }),
  workspaces: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.enum(["personal", "company"]) }),
  ),
  mailboxes: z.array(
    z.object({
      id: z.string(),
      address: z.string(),
      kind: z.enum(["personal", "shared"]).describe("shared: a team inbox (helpdesk)."),
      workspace: z.string(),
      status: z.string(),
      inbox: z.number(),
      unread: z.number(),
      later: z.number(),
      lanes: laneCounts.describe("Inbox threads per triage lane."),
      helpdesk: z
        .record(z.string(), z.number())
        .optional()
        .describe("Shared inboxes: conversations per view (unassigned, mine, open, pending, …)."),
    }),
  ),
  attention: z
    .array(threadSummarySchema)
    .describe("Inbox threads that need the person: needs reply, then unsure, then unread."),
  notifications: z.object({
    unread: z.number(),
    items: z.array(
      z.object({
        kind: z.string(),
        thread_id: z.string(),
        subject: z.string(),
        url: z.string(),
        at: z.string(),
      }),
    ),
  }),
});

const inputSchema = z.object({
  mailbox: z
    .string()
    .optional()
    .describe("Only this inbox: its id or address. Default: every inbox."),
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe("Only this workspace id. Default: every workspace."),
  limit: z.number().int().min(1).max(50).default(10).describe("How many threads in attention."),
});

export function registerInbox(server: McpServer, context: ToolContext) {
  server.registerTool(
    "inbox",
    {
      title: "Inbox overview",
      description:
        "Start here. Returns the person's workspaces and inboxes with counts (inbox, unread, Later, triage lanes, helpdesk views), the inbox threads that need them most (needs reply first, then unsure, then unread) with snippets, and unread notifications. Use `search` to find other threads and `fetch` to read them.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "inbox", () => overview(context, input)),
  );
}

async function overview(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const { db, caller } = context;
  const scoped = readsFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const { reads, scope } = scoped;
  const [user, workspaces, mailboxes, counts, helpdesk] = await Promise.all([
    db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, caller.userId))
      .then(([row]) => row),
    listUserWorkspaces(db, caller.userId, { includePersonal: true }),
    reads.listMailboxes(),
    reads.counts(),
    reads.conversationCounts(),
  ]);
  if (!user) return toolError("This connection's account no longer exists.");

  const mailbox = input.mailbox
    ? mailboxes.find(
        (m) => m.id === input.mailbox || m.address.toLowerCase() === input.mailbox!.toLowerCase(),
      )
    : undefined;
  if (input.mailbox && !mailbox) {
    return toolError(
      `No inbox "${input.mailbox}" you can open. Call \`inbox\` without \`mailbox\` to list them.`,
    );
  }
  const mailboxId = mailbox?.id;
  const [needsReply, unsure, recent, notifications] = await Promise.all([
    reads.listThreads({ mailboxId, view: "inbox", lane: "needs_reply", limit: input.limit }),
    reads.listThreads({ mailboxId, view: "inbox", lane: "unsure", limit: input.limit }),
    reads.listThreads({ mailboxId, view: "inbox", limit: input.limit * 2 }),
    reads.listNotifications({ unreadOnly: true, limit: 10 }),
  ]);

  const addressOf = new Map(mailboxes.map((m) => [m.id, m.address]));
  const format = {
    webAppURL: context.webAppURL,
    mailboxAddress: (id: string) => addressOf.get(id) ?? "",
  };
  const seen = new Set<string>();
  const attention = [...needsReply, ...unsure, ...recent.filter((t) => t.unread)]
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .slice(0, input.limit)
    .map((t) => threadSummary(t, format));

  const countsOf = new Map(counts.map((c) => [c.mailboxId, c]));
  const helpdeskOf = new Map(helpdesk.map((h) => [h.mailboxId, h.views]));
  const reach = (orgId: string) => !scope || orgId === scope;
  return result({
    now: new Date().toISOString(),
    me: { name: user.name, email: user.email },
    workspaces: workspaces
      .filter((w) => reach(w.id))
      .map(({ id, name, kind }) => ({ id, name, kind })),
    mailboxes: mailboxes
      .filter((m) => !mailboxId || m.id === mailboxId)
      .map((m) => {
        const c = countsOf.get(m.id);
        const views = helpdeskOf.get(m.id);
        return {
          id: m.id,
          address: m.address,
          kind: m.kind,
          workspace: m.orgId,
          status: m.status,
          inbox: c?.inbox ?? 0,
          unread: c?.unread ?? 0,
          later: c?.later ?? 0,
          lanes: {
            needs_reply: c?.lanes.needs_reply ?? 0,
            unsure: c?.lanes.unsure ?? 0,
            waiting_on_them: c?.lanes.waiting_on_them ?? 0,
            fyi: c?.lanes.fyi ?? 0,
            noise: c?.lanes.noise ?? 0,
          },
          ...(m.kind === "shared" && views ? { helpdesk: views } : {}),
        };
      }),
    attention,
    notifications: {
      unread: notifications.unread,
      items: notifications.notifications.flatMap((n) =>
        n.threadId
          ? [
              {
                kind: n.kind,
                thread_id: n.threadId,
                subject: n.subject,
                url: threadUrl(context.webAppURL, n.threadId),
                at: n.createdAt.toISOString(),
              },
            ]
          : [],
      ),
    },
  });
}

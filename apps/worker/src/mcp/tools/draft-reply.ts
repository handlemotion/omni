// `draft_reply`: write a reply for the person to review (ADR 0029). It becomes an Omni draft on
// the thread, where the composer opens it; nothing is sent. The person sends it, edits it or
// discards it in Omni.
import type { McpServer } from "@modelcontextprotocol/server";
import { createDraft, schema } from "@omni/db";
import { replyRecipients, replySubject } from "@omni/mail-core/compose";
import { z } from "zod";
import { inGoodStanding } from "../../billing.ts";
import { fanOut } from "../../realtime.ts";
import { result, threadUrl, toolError } from "../format.ts";
import { readsFor } from "../scope.ts";
import { guarded, type ToolContext } from "../server.ts";

const inputSchema = z.object({
  thread_id: z.string().min(1).describe("The thread to reply in (from `search` or `inbox`)."),
  body: z.string().trim().min(1).max(50_000).describe("The reply, as plain text."),
  reply_all: z.boolean().default(false).describe("Copy everyone else on the message."),
  message_id: z
    .string()
    .min(1)
    .optional()
    .describe("The message to reply to (from `fetch`). Default: the latest one."),
  workspace: z.string().min(1).optional(),
});

const outputSchema = z.object({
  draft_id: z.string(),
  url: z.string().describe("Where the person reviews and sends it."),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
});

async function draft(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const scoped = readsFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const [thread] = await scoped.reads.getThreads([input.thread_id]);
  const member = thread && (await scoped.reads.memberFor(thread.id));
  if (!thread || !member) {
    return toolError("No thread with that id you can see. Ids come from `search` or `inbox`.");
  }
  if (!(await inGoodStanding(context.db, context.config, member.orgId))) {
    return toolError("This workspace is read-only until its plan is paid.");
  }
  const message = input.message_id
    ? thread.messages.find((m) => m.id === input.message_id)
    : thread.messages.at(-1);
  if (!message) return toolError("That message is not in this thread. Ids come from `fetch`.");

  const recipients = replyRecipients(message, thread.mailboxAddress, input.reply_all);
  const subject = replySubject(message.subject);
  const created = await createDraft(context.db, member.id, {
    mailboxId: thread.mailboxId,
    kind: "reply",
    threadId: thread.id,
    sourceMessageId: message.id,
    to: recipients.to.map((address) => ({ name: null, address })),
    cc: recipients.cc.map((address) => ({ name: null, address })),
    subject,
    bodyText: input.body,
  });
  if (!created) return toolError("The draft could not be saved on that thread.");
  await context.db.insert(schema.auditEvents).values({
    orgId: member.orgId,
    actorMemberId: member.id,
    action: "mcp.draft_reply",
    subject: thread.id,
    data: { via: "mcp", clientId: context.caller.clientId, draftId: created.id },
  });
  // Open apps show the new draft on the thread.
  context.waitUntil(
    fanOut(
      context.env,
      context.db,
      context.config,
      new Map([[thread.mailboxId, new Set([thread.id])]]),
    ),
  );
  return result({
    draft_id: created.id,
    url: threadUrl(context.webAppURL, thread.id),
    to: recipients.to,
    cc: recipients.cc,
    subject,
  });
}

export function registerDraftReply(server: McpServer, context: ToolContext) {
  server.registerTool(
    "draft_reply",
    {
      title: "Draft a reply",
      description:
        "Write a reply on a thread as a draft in Omni. It is never sent: the person reviews, edits and sends it from the thread at `url`, so tell them it is there. Recipients follow the usual reply rules (reply_all copies everyone else).",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "draft_reply", () => draft(context, input)),
  );
}

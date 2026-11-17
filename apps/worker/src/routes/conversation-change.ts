import { applyConversationChange, type ChangeResult, type ConversationChange } from "@omni/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { errorBody } from "../errors.ts";
import { pingMailService } from "../mail-service.ts";
import { fanOut, notifyMembers } from "../realtime.ts";
import { optionalJsonBody } from "../validator.ts";

export const expectedAssignee = z.string().min(1).nullable().optional();

const claimBody = z.object({
  expectedAssignee,
});

/** The claim's optional precondition; older web builds send no body, which means `{}`. */
export const claimPrecondition = (c: Context<AppEnv>) => optionalJsonBody(c, claimBody);

export const failures = {
  not_found: [404, "not found"],
  personal_mailbox: [409, "conversation actions are for shared inboxes"],
  not_assignable: [422, "that member cannot see this inbox"],
  unknown_tag: [422, "that tag is not one of this inbox's"],
  invalid_snooze: [422, "snooze until a time in the future"],
  assignee_changed: [409, "a teammate assigned this conversation first"],
} as const;

/**
 * Applies `change` as this member, then tells the inbox's members and the mail service. A retry
 * under the same Idempotency-Key changes nothing once the first attempt did, so it cannot undo a
 * teammate's change made in between.
 */
export async function applyChange(
  c: Context<AppEnv>,
  threadId: string,
  change: ConversationChange,
) {
  const result: ChangeResult = await applyConversationChange(c.var.db, {
    threadId,
    actorMemberId: c.var.member.id,
    change,
    requestId: c.var.requestId,
    idempotencyKey: c.req.header("idempotency-key"),
  });
  if (!result.ok) {
    const [status, message] = failures[result.reason];
    if (result.reason === "assignee_changed" && result.conversation) {
      const body = errorBody(c, "conflict", message);
      return c.json({ ...body, conversation: result.conversation }, 409);
    }
    throw new HTTPException(status, { message });
  }
  if (result.queuedActions > 0) c.executionCtx.waitUntil(pingMailService(c.var));
  if (result.changed) {
    const { mailboxId, id, orgId } = result.conversation;
    c.executionCtx.waitUntil(
      Promise.all([
        fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
        notifyMembers(c.env, c.var.db, {
          orgId,
          threadId: id,
          memberIds: result.notified,
          kind: "assigned",
        }),
      ]),
    );
  }
  return c.json({ conversation: result.conversation, changed: result.changed });
}

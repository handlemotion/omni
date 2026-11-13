// What owners and admins do with a company inbox that outlived its owner, and removing any inbox
// (ADR 0026). A removed member's personal inbox stays with the company, orphaned: nobody can open
// it and it stops syncing. It can be given to a member, turned into a shared inbox, or removed.
// Every action is recorded; `GET /workspace/events` lists them, without mail content.
import {
  HOSTED_DISCONNECT_PATH,
  hostedDisconnectResultSchema,
  MAILBOX_DISCONNECT_PATH,
} from "@omni/contracts";
import {
  giveOrphanedInbox,
  listInboxEvents,
  listWorkspaceMailboxes,
  membersStrandedWithout,
  shareOrphanedInbox,
  type OrphanResult,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { logInboxAction, requireCompanyManager } from "../inbox-admin.ts";
import { callMailService } from "../mail-service.ts";
import { fromMailService } from "../provision-mailbox.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";

function answerOrphan(result: OrphanResult) {
  if (result === "not_found") throw new HTTPException(404, { message: "not found" });
  if (result === "member_not_found") {
    throw new HTTPException(404, { message: "no such member in this workspace" });
  }
  if (result === "not_orphaned") {
    throw new HTTPException(409, { message: "only an inbox whose owner left can change hands" });
  }
}

/**
 * Removes a mailbox from the workspace, whatever its provider: Omni stops syncing it and forgets
 * its login; the mail stays at the host. Refused (409) when it is someone's only inbox. Retrying
 * one already gone answers 204.
 */
export async function removeInbox(c: Context<AppEnv>, mailboxId: string, hostedOnly: boolean) {
  const orgId = c.var.member.orgId;
  const mailbox = (await listWorkspaceMailboxes(c.var.db, orgId)).find((m) => m.id === mailboxId);
  if (!mailbox) return c.body(null, 204);
  if (hostedOnly && mailbox.provider !== "purelymail") {
    throw new HTTPException(404, { message: "not found" });
  }
  if ((await membersStrandedWithout(c.var.db, orgId, mailboxId)).length > 0) {
    throw new HTTPException(409, {
      message: "this is the only inbox someone can open: give them another one first",
    });
  }
  await callMailService(
    c.var,
    hostedOnly ? HOSTED_DISCONNECT_PATH : MAILBOX_DISCONNECT_PATH,
    { orgId, mailboxId },
    hostedDisconnectResultSchema,
  ).catch(fromMailService);
  await logInboxAction(c, "inbox.removed", mailbox.address, { mailboxId });
  return c.body(null, 204);
}

const people = z.array(z.string().min(1)).min(1).max(500);

export const workspaceInboxes = new Hono<AppEnv>()
  .use("/workspace/inboxes/*", requireCompanyManager)
  .use("/workspace/events", requireCompanyManager)

  .delete("/workspace/inboxes/:id", limitPerMember("provision"), (c) =>
    removeInbox(c, c.req.param("id"), false),
  )

  /** Gives an orphaned inbox to a member: theirs from now on, old mail included. Idempotent. */
  .post(
    "/workspace/inboxes/:id/owner",
    zValidator("json", z.object({ memberId: z.string().min(1) })),
    async (c) => {
      const mailboxId = c.req.param("id");
      const { memberId } = c.req.valid("json");
      const { result, address } = await giveOrphanedInbox(
        c.var.db,
        c.var.member.orgId,
        mailboxId,
        memberId,
      );
      answerOrphan(result);
      await logInboxAction(c, "inbox.given", address ?? mailboxId, {
        mailboxId,
        memberIds: [memberId],
      });
      return c.json({ ok: true as const });
    },
  )

  /** Turns an orphaned inbox into a shared inbox seen by `memberIds`. Idempotent. */
  .post(
    "/workspace/inboxes/:id/shared",
    zValidator("json", z.object({ memberIds: people })),
    async (c) => {
      const mailboxId = c.req.param("id");
      const memberIds = [...new Set(c.req.valid("json").memberIds)];
      const { result, address } = await shareOrphanedInbox(
        c.var.db,
        c.var.member.orgId,
        mailboxId,
        memberIds,
      );
      answerOrphan(result);
      await logInboxAction(c, "inbox.made_shared", address ?? mailboxId, { mailboxId, memberIds });
      return c.json({ ok: true as const });
    },
  )

  /** The workspace's inbox actions, newest first: who did what to which address. */
  .get("/workspace/events", async (c) =>
    c.json({ events: await listInboxEvents(c.var.db, c.var.member.orgId) }),
  );

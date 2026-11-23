import { cancelSend } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";
import { fanOut, notifyMembers } from "../realtime.ts";
import { idempotencyHeader, notFound, pingLater } from "./mail.ts";
import {
  forwardBodySchema,
  replyBody,
  sendBody,
  sendForward,
  sendNew,
  sendReply,
  sendResponse,
  sendUnlessStale,
} from "./send.ts";

export const compose = new Hono<AppEnv>()
  .post(
    "/send",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    zValidator("json", sendBody),
    async (c) => {
      const action = await sendNew(
        c,
        c.req.valid("json"),
        c.req.valid("header")["idempotency-key"],
      );
      return c.json(sendResponse(action), 202);
    },
  )

  .post(
    "/threads/:id/reply",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    zValidator("json", replyBody),
    (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      return sendUnlessStale(c, key, () =>
        sendReply(c, c.req.param("id"), c.req.valid("json"), key),
      );
    },
  )

  .post(
    "/threads/:id/forward",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    zValidator("json", forwardBodySchema),
    (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      return sendUnlessStale(c, key, () =>
        sendForward(c, c.req.param("id"), c.req.valid("json"), key),
      );
    },
  )

  .post("/actions/:id/cancel", async (c) => {
    const result = await cancelSend(c.var.db, c.var.member.id, c.req.param("id"));
    if (!result) notFound();
    if (result === "too_late") {
      return apiError(c, "conflict", "already sent");
    }
    if (result.handoff?.changed) {
      if (result.handoff.queuedActions > 0) pingLater(c);
      const { mailboxId, id, orgId } = result.handoff.conversation;
      c.executionCtx.waitUntil(
        Promise.all([
          fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
          notifyMembers(c.env, c.var.db, {
            orgId,
            threadId: id,
            memberIds: result.handoff.notified,
            kind: "assigned",
          }),
        ]),
      );
    }
    return c.json({ cancelled: true, payload: result.payload });
  });

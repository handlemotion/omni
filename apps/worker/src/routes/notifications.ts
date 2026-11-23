import { forMember, markNotificationsRead } from "@omni/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { timePageCursor, timePageQuery } from "../cursor.ts";
import { zValidator } from "../validator.ts";

const notificationsQuery = z.object({
  unread: z.enum(["true", "false"]).default("false"),
  cursor: timePageQuery,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const readBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500).optional() });

/** The member's mentions, assignments and notes on threads they follow. */
export const notifications = new Hono<AppEnv>()
  .get("/notifications", zValidator("query", notificationsQuery), async (c) => {
    const { unread, cursor, limit } = c.req.valid("query");
    const page = await forMember(c.var.db, c.var.member.id).listNotifications({
      unreadOnly: unread === "true",
      before: cursor,
      limit,
    });
    const last = page.notifications.at(-1);
    return c.json({
      unread: page.unread,
      notifications: page.notifications.map(({ pageAt: _pageAt, ...row }) => row),
      nextCursor:
        last && page.notifications.length === limit ? timePageCursor(last.pageAt, last.id) : null,
    });
  })

  .post("/notifications/read", zValidator("json", readBody), async (c) => {
    const { ids } = c.req.valid("json");
    const marked = await markNotificationsRead(c.var.db, c.var.member.id, ids ?? "all");
    return c.json({ marked });
  });

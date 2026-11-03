// The workspace and account switcher's data: every organization the signed-in user belongs to,
// with its setup step and the mailboxes their member there can open. Works for a user who has no
// organization yet (an empty list), so it sits before the member-only `/api` routes.
import { listUserWorkspaces } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveSession, type AppEnv } from "../context.ts";

export const workspaces = new Hono<AppEnv>().get("/", async (c) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  return c.json({
    /** The session's active organization (what `/api/me` answers for), or null with none. */
    activeOrganizationId: resolved.member?.orgId ?? null,
    workspaces: await listUserWorkspaces(c.var.db, resolved.user.id),
  });
});

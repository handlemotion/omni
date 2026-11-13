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
    // `?include=personal` adds the user's Personal space (ADR 0024); older clients never ask.
    // A session opened with a company's address lists only that company (ADR 0024).
    workspaces: (
      await listUserWorkspaces(c.var.db, resolved.user.id, {
        includePersonal: c.req.query("include") === "personal",
      })
    ).filter((workspace) => !resolved.user.scopeOrgId || workspace.id === resolved.user.scopeOrgId),
    scopedTo: resolved.user.scopeOrgId,
  });
});

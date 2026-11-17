import { listUserWorkspaces } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveSession, type AppEnv } from "../context.ts";

export const workspaces = new Hono<AppEnv>().get("/", async (c) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  return c.json({
    activeOrganizationId: resolved.member?.orgId ?? null,
    workspaces: (
      await listUserWorkspaces(c.var.db, resolved.user.id, {
        includePersonal: c.req.query("include") === "personal",
      })
    ).filter((workspace) => !resolved.user.scopeOrgId || workspace.id === resolved.user.scopeOrgId),
    scopedTo: resolved.user.scopeOrgId,
  });
});

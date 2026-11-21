import { listUserWorkspaces } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { personalSpaceForOldClients, resolveSession, type AppEnv } from "../context.ts";

export const workspaces = new Hono<AppEnv>().get("/", personalSpaceForOldClients, async (c) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  const { user } = resolved;
  return c.json({
    activeOrganizationId: resolved.member?.orgId ?? null,
    workspaces: (
      await listUserWorkspaces(c.var.db, user.id, {
        includePersonal: c.req.query("include") === "personal",
      })
    ).filter((workspace) => !user.scopeOrgId || workspace.id === user.scopeOrgId),
    scopedTo: user.scopeOrgId,
  });
});

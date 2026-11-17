import { chooseOAuthWorkspace } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";

function isSignatureParam(key: string) {
  return key === "sig" || key === "exp" || key.startsWith("ba_");
}

const workspaceBody = z.object({
  workspace: z.string().min(1).nullable(),
});

export const oauth = new Hono<AppEnv>()
  .get("/login", (c) => {
    const authorize = new URLSearchParams();
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (!isSignatureParam(key)) authorize.append(key, value);
    }
    const next = `/api/auth/oauth2/authorize?${authorize.toString()}`;
    const login = new URL("/login", c.var.config.auth.webAppURL);
    login.searchParams.set("redirect", next);
    return c.redirect(login.toString(), 302);
  })
  .post("/workspace", zValidator("json", workspaceBody), async (c) => {
    const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HTTPException(401, { message: "sign in first" });
    const chosen = await chooseOAuthWorkspace(c.var.db, {
      sessionId: session.session.id,
      userId: session.user.id,
      orgId: c.req.valid("json").workspace,
    });
    if (!chosen) throw new HTTPException(403, { message: "not one of your workspaces" });
    return c.json({ ok: true });
  });

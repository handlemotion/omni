import {
  acceptJoinRequest,
  declineJoinRequest,
  joinStatus,
  listJoinRequests,
  notifyMemberJoined,
  ownerEmails,
  requestToJoin,
} from "@omni/db";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveSession, systemMailSender, type AppEnv } from "../context.ts";
import { notifyMembers } from "../realtime.ts";

async function asker(c: Context<AppEnv>) {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  const orgId = resolved.user.scopeOrgId;
  if (!orgId || resolved.member) throw new HTTPException(404, { message: "nothing to join" });
  return { user: resolved.user, orgId };
}

async function decider(c: Context<AppEnv>) {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  const member = resolved.member;
  if (!member || !(member.role.includes("owner") || member.role.includes("admin"))) {
    throw new HTTPException(403, { message: "only owners and admins decide on join requests" });
  }
  return member;
}

async function tellOwners(c: Context<AppEnv>, orgId: string, company: string, who: string) {
  const send = systemMailSender({ email: c.env.EMAIL, config: c.var.config, log: c.var.log });
  const app = c.var.config.auth.appName;
  const url = new URL("/settings", c.var.config.auth.webAppURL ?? c.var.config.auth.baseURL);
  for (const to of await ownerEmails(c.var.db, orgId)) {
    await send({
      to,
      subject: `${who} asked to join ${company} on ${app}`,
      text: `${who} asked to join ${company}. Accept or decline in Settings, People:\n\n${url}`,
    }).catch(() => {});
  }
}

async function announceJoin(c: Context<AppEnv>, orgId: string, userId: string) {
  const memberIds = await notifyMemberJoined(c.var.db, { orgId, userId });
  await notifyMembers(c.env, c.var.db, { orgId, threadId: null, memberIds, kind: "member_joined" });
}

export const join = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { user, orgId } = await asker(c);
    const status = await joinStatus(c.var.db, { orgId, userId: user.id });
    if (!status) throw new HTTPException(404, { message: "nothing to join" });
    return c.json(status);
  })
  .post("/", async (c) => {
    const { user, orgId } = await asker(c);
    const status = await joinStatus(c.var.db, { orgId, userId: user.id });
    if (!status) throw new HTTPException(404, { message: "nothing to join" });
    const { created } = await requestToJoin(c.var.db, { orgId, userId: user.id });
    if (created) {
      c.executionCtx.waitUntil(tellOwners(c, orgId, status.company.name, user.email));
    }
    return c.json({ company: status.company, requested: true });
  })
  .get("/requests", async (c) => {
    const member = await decider(c);
    return c.json({ requests: await listJoinRequests(c.var.db, member.orgId) });
  })
  .post("/requests/:id/accept", async (c) => {
    const member = await decider(c);
    const userId = await acceptJoinRequest(c.var.db, {
      orgId: member.orgId,
      requestId: c.req.param("id"),
    });
    if (!userId) throw new HTTPException(404, { message: "not found" });
    c.executionCtx.waitUntil(announceJoin(c, member.orgId, userId));
    return c.body(null, 204);
  })
  .post("/requests/:id/decline", async (c) => {
    const member = await decider(c);
    const declined = await declineJoinRequest(c.var.db, {
      orgId: member.orgId,
      requestId: c.req.param("id"),
    });
    if (!declined) throw new HTTPException(404, { message: "not found" });
    return c.body(null, 204);
  });

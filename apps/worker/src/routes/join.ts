// Join requests (ADR 0024 decision 3). A sign-in with an address on a company's claimed domain
// reaches only that company; someone who is not its member gets nothing else, so they ask to
// join here, and the company's owners and admins accept or decline. Mounted ahead of the member
// API: the person asking has no member yet.
import {
  acceptJoinRequest,
  declineJoinRequest,
  joinStatus,
  listJoinRequests,
  ownerEmails,
  requestToJoin,
} from "@omni/db";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveSession, systemMailSender, type AppEnv } from "../context.ts";

/** The signed-in person and the company their sign-in is scoped to, when they are not its member. */
async function asker(c: Context<AppEnv>) {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  const orgId = resolved.user.scopeOrgId;
  if (!orgId || resolved.member) throw new HTTPException(404, { message: "nothing to join" });
  return { user: resolved.user, orgId };
}

/** The active workspace's owner or admin, who decides on requests. */
async function decider(c: Context<AppEnv>) {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  const member = resolved.member;
  if (!member || !(member.role.includes("owner") || member.role.includes("admin"))) {
    throw new HTTPException(403, { message: "only owners and admins decide on join requests" });
  }
  return member;
}

/** Tells the company's owners someone asked. Best effort: the request stands either way. */
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

export const join = new Hono<AppEnv>()
  /** `{ company: { id, name }, requested }` for a scoped sign-in that is not a member; else 404. */
  .get("/", async (c) => {
    const { user, orgId } = await asker(c);
    const status = await joinStatus(c.var.db, { orgId, userId: user.id });
    if (!status) throw new HTTPException(404, { message: "nothing to join" });
    return c.json(status);
  })
  /** Asks to join; asking again changes nothing and tells nobody twice. */
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
  /** The requests waiting in the active workspace, for its owners and admins. */
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

import {
  forMember,
  listMemberRoleDescriptions,
  listWorkspaceMembers,
  MAX_ROLE_DESCRIPTION,
  setMemberRoleDescription,
} from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { requireManager } from "../inbox-admin.ts";
import { zValidator } from "../validator.ts";

const descriptionBody = z.object({ description: z.string().max(MAX_ROLE_DESCRIPTION) });

export const aiSettings = new Hono<AppEnv>()
  .use("/workspace/ai", requireManager)
  .use("/workspace/ai/*", requireManager)

  .get("/workspace/ai", async (c) => {
    const { db, member } = c.var;
    const [people, roles, inboxes] = await Promise.all([
      listWorkspaceMembers(db, member.orgId),
      listMemberRoleDescriptions(db, member.orgId),
      forMember(db, member.id).listSharedInboxTags(),
    ]);
    return c.json({
      members: people.map((person) => ({
        id: person.id,
        user: person.user,
        sharedInboxes: person.sharedInboxes,
        roleDescription: roles.get(person.id) ?? null,
      })),
      sharedInboxes: inboxes,
    });
  })

  .put("/workspace/ai/members/:memberId/role", zValidator("json", descriptionBody), async (c) => {
    const { description } = c.req.valid("json");
    const found = await setMemberRoleDescription(
      c.var.db,
      c.var.member.orgId,
      c.req.param("memberId"),
      description,
    );
    if (!found) throw new HTTPException(404, { message: "no such member in this workspace" });
    return c.json({ roleDescription: description.trim() || null });
  });

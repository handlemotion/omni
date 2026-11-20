import { crmPutProjectAccessBodySchema, type CrmProjectAccessResponse } from "@omni/contracts";
import type { CrmProjectAccess } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announce, memberCrm, refused } from "./http.ts";

const wireAccess = (access: CrmProjectAccess[]) =>
  ({
    access: access.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  }) satisfies CrmProjectAccessResponse;

const emailOf = (c: Context<AppEnv>) => decodeURIComponent(c.req.param("email") ?? "");

/** Who outside the team reaches a project (`docs/spec/crm.md`, "Project access"). */
export const access = new Hono<AppEnv>()
  .get("/deals/:id/access", async (c) => {
    const found = await memberCrm(c).projectAccess(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json(wireAccess(found.access));
  })

  .put("/deals/:id/access/:email", zValidator("json", crmPutProjectAccessBodySchema), async (c) => {
    const dealId = c.req.param("id");
    const put = await memberCrm(c).grantProjectAccess(dealId, {
      email: emailOf(c),
      scope: c.req.valid("json").scope,
    });
    if (put.status !== "ok") return refused(c, put);
    await announce(c, "deal", [dealId]);
    return c.json(wireAccess(put.access), put.added ? 201 : 200);
  })

  .delete("/deals/:id/access/:email", async (c) => {
    const dealId = c.req.param("id");
    const removed = await memberCrm(c).revokeProjectAccess(dealId, emailOf(c));
    if (removed.status !== "ok") return refused(c, removed);
    await announce(c, "deal", [dealId]);
    return c.json(wireAccess(removed.access));
  });

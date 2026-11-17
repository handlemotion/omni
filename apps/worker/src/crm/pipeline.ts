import {
  crmPutSettingsBodySchema,
  crmPutStagesBodySchema,
  type CrmSettingsResponse,
  type CrmStagesResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announce, memberCrm, refused } from "./http.ts";

export const pipeline = new Hono<AppEnv>()
  .get("/stages", async (c) => {
    const found = await memberCrm(c).stages();
    if (found.status !== "ok") return refused(c, found);
    return c.json({ stages: found.stages } satisfies CrmStagesResponse);
  })

  .put("/stages", zValidator("json", crmPutStagesBodySchema), async (c) => {
    const replaced = await memberCrm(c).replaceStages(c.req.valid("json").stages);
    if (replaced.status !== "ok") return refused(c, replaced);
    await announce(
      c,
      "stages",
      replaced.stages.map((stage) => stage.id),
    );
    return c.json({ stages: replaced.stages } satisfies CrmStagesResponse);
  })

  .get("/settings", async (c) => {
    const found = await memberCrm(c).settings();
    if (found.status !== "ok") return refused(c, found);
    return c.json({ settings: found.settings } satisfies CrmSettingsResponse);
  })

  .put("/settings", zValidator("json", crmPutSettingsBodySchema), async (c) => {
    const saved = await memberCrm(c).putSettings(c.req.valid("json"));
    if (saved.status !== "ok") return refused(c, saved);
    await announce(c, "settings", [c.var.member.orgId]);
    return c.json({ settings: saved.settings } satisfies CrmSettingsResponse);
  });

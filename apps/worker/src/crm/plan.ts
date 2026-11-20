import {
  crmCreateDeliverableBodySchema,
  crmCreateMilestoneBodySchema,
  crmUpdateDeliverableBodySchema,
  crmUpdateMilestoneBodySchema,
  type CrmDeliverableResponse,
  type CrmMilestoneResponse,
  type CrmPlanResponse,
} from "@omni/contracts";
import type { CrmDeliverable, CrmMilestone, CrmPlan } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announce, memberCrm, refused } from "./http.ts";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

export const wireMilestone = (milestone: CrmMilestone) => ({
  ...milestone,
  completedAt: isoOrNull(milestone.completedAt),
  createdAt: iso(milestone.createdAt),
  updatedAt: iso(milestone.updatedAt),
});

export const wireDeliverable = (deliverable: CrmDeliverable) => ({
  ...deliverable,
  reviewedAt: isoOrNull(deliverable.reviewedAt),
  createdAt: iso(deliverable.createdAt),
  updatedAt: iso(deliverable.updatedAt),
});

export const wirePlan = (plan: CrmPlan) =>
  ({
    milestones: plan.milestones.map(wireMilestone),
    deliverables: plan.deliverables.map(wireDeliverable),
  }) satisfies CrmPlanResponse;

/** A project's milestones and deliverables (`docs/spec/crm.md`, "Plan a project"). */
export const plan = new Hono<AppEnv>()
  .get("/deals/:id/plan", async (c) => {
    const found = await memberCrm(c).plan(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json(wirePlan(found.plan));
  })

  .post("/deals/:id/milestones", zValidator("json", crmCreateMilestoneBodySchema), async (c) => {
    const made = await memberCrm(c).createMilestone(c.req.param("id"), c.req.valid("json"));
    if (made.status !== "ok") return refused(c, made);
    await announce(c, "deal", [made.milestone.dealId]);
    const body = { milestone: wireMilestone(made.milestone) } satisfies CrmMilestoneResponse;
    return c.json(body, 201);
  })

  .patch("/milestones/:id", zValidator("json", crmUpdateMilestoneBodySchema), async (c) => {
    const changed = await memberCrm(c).updateMilestone(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    await announce(c, "deal", [changed.milestone.dealId]);
    return c.json({
      milestone: wireMilestone(changed.milestone),
    } satisfies CrmMilestoneResponse);
  })

  .delete("/milestones/:id", async (c) => {
    const deleted = await memberCrm(c).deleteMilestone(c.req.param("id"));
    if (deleted.status !== "ok") return refused(c, deleted);
    await announce(c, "deal", [deleted.milestone.dealId]);
    return c.body(null, 204);
  })

  .post(
    "/deals/:id/deliverables",
    zValidator("json", crmCreateDeliverableBodySchema),
    async (c) => {
      const made = await memberCrm(c).createDeliverable(c.req.param("id"), c.req.valid("json"));
      if (made.status !== "ok") return refused(c, made);
      await announce(c, "deal", [made.deliverable.dealId]);
      const body = {
        deliverable: wireDeliverable(made.deliverable),
      } satisfies CrmDeliverableResponse;
      return c.json(body, 201);
    },
  )

  .patch("/deliverables/:id", zValidator("json", crmUpdateDeliverableBodySchema), async (c) => {
    const changed = await memberCrm(c).updateDeliverable(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    await announce(c, "deal", [changed.deliverable.dealId]);
    return c.json({
      deliverable: wireDeliverable(changed.deliverable),
    } satisfies CrmDeliverableResponse);
  })

  .delete("/deliverables/:id", async (c) => {
    const deleted = await memberCrm(c).deleteDeliverable(c.req.param("id"));
    if (deleted.status !== "ok") return refused(c, deleted);
    await announce(c, "deal", [deleted.deliverable.dealId]);
    return c.body(null, 204);
  });

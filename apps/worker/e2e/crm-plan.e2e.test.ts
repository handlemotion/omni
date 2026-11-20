import { crmPlanResponseSchema } from "@omni/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

test("a project's plan round-trips over HTTP in the contract's shape, days as days", async () => {
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const deal = (await stack.api(ana.jar, "POST", "/deals", { name: "Rebrand" })).body.deal;
  const other = (await stack.api(ana.jar, "POST", "/deals", { name: "Other" })).body.deal;

  const milestone = await stack.api(ana.jar, "POST", `/deals/${deal.id}/milestones`, {
    title: "Discovery",
    targetOn: "2026-12-15",
  });
  expect(milestone.status).toBe(201);
  const made = await stack.api(ana.jar, "POST", `/deals/${deal.id}/deliverables`, {
    title: "Moodboard",
    milestoneId: milestone.body.milestone.id,
    dueOn: "2026-12-10",
    clientVisible: true,
  });
  expect(made.status).toBe(201);

  const wrong = await stack.api(ana.jar, "POST", `/deals/${other.id}/deliverables`, {
    title: "x",
    milestoneId: milestone.body.milestone.id,
  });
  expect(wrong.status).toBe(400);
  expect(wrong.body.param).toBe("milestoneId");

  const changed = await stack.api(ana.jar, "PATCH", `/deliverables/${made.body.deliverable.id}`, {
    status: "in_review",
  });
  expect(changed.body.deliverable.status).toBe("in_review");

  const plan = await stack.api(ana.jar, "GET", `/deals/${deal.id}/plan`);
  expect(plan.status).toBe(200);
  const parsed = crmPlanResponseSchema.parse(plan.body);
  expect(parsed.milestones).toMatchObject([{ title: "Discovery", targetOn: "2026-12-15" }]);
  expect(parsed.deliverables).toMatchObject([
    { title: "Moodboard", dueOn: "2026-12-10", status: "in_review", clientVisible: true },
  ]);

  const outsider = await stack.member((await stack.company("other")).id);
  expect((await stack.api(outsider.jar, "GET", `/deals/${deal.id}/plan`)).status).toBe(404);
});

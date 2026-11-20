import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { crmMilestones } from "../src/schema/index.ts";
import { addFile } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function team(slug: string) {
  const org = await createOrg(db, slug);
  const ana = forMember(db, (await createMember(db, org.id, "ana")).id);
  const ben = forMember(db, (await createMember(db, org.id, "ben")).id);
  return { org, ana, ben };
}

test("another workspace can neither read nor change a project's plan", async () => {
  const { ana } = await team("plan-leak-acme");
  const other = await createOrg(db, "plan-leak-other");
  const eve = forMember(db, (await createMember(db, other.id, "eve")).id).crm;
  const deal = ok(await ana.crm.createDeal({ name: "Rebrand" })).deal;
  const milestone = ok(await ana.crm.createMilestone(deal.id, { title: "Discovery" })).milestone;
  const deliverable = ok(
    await ana.crm.createDeliverable(deal.id, { title: "Moodboard", milestoneId: milestone.id }),
  ).deliverable;

  expect((await eve.plan(deal.id)).status).toBe("not_found");
  expect((await eve.createMilestone(deal.id, { title: "Mine" })).status).toBe("not_found");
  expect((await eve.createDeliverable(deal.id, { title: "Mine" })).status).toBe("not_found");
  expect((await eve.updateMilestone(milestone.id, { title: "Mine" })).status).toBe("not_found");
  expect((await eve.updateDeliverable(deliverable.id, { status: "approved" })).status).toBe(
    "not_found",
  );
  expect((await eve.deleteMilestone(milestone.id)).status).toBe("not_found");
  expect((await eve.deleteDeliverable(deliverable.id)).status).toBe("not_found");

  const theirDeal = ok(await eve.createDeal({ name: "Theirs" })).deal;
  expect(
    await eve.createDeliverable(theirDeal.id, { title: "x", milestoneId: milestone.id }),
  ).toEqual({ status: "invalid_milestone" });

  const plan = ok(await ana.crm.plan(deal.id)).plan;
  expect(plan.milestones.map((m) => m.title)).toEqual(["Discovery"]);
  expect(plan.deliverables).toMatchObject([{ title: "Moodboard", status: "draft" }]);
});

test("a deliverable takes only a milestone of its own deal and a file its author can open", async () => {
  const { ana, ben } = await team("plan-refs");
  const website = ok(await ana.crm.createDeal({ name: "Website" })).deal;
  const app = ok(await ana.crm.createDeal({ name: "App" })).deal;
  const appMilestone = ok(await ana.crm.createMilestone(app.id, { title: "Beta" })).milestone;
  const bensPrivate = await addFile(ben.storage, { space: "personal" }, "notes.pdf");
  const folder = ok(await ana.crm.dealFolder(website.id)).nodeId;
  const shared = await addFile(ana.storage, { parentId: folder }, "homepage.pdf");

  expect(
    await ana.crm.createDeliverable(website.id, { title: "Home", milestoneId: appMilestone.id }),
  ).toEqual({ status: "invalid_milestone" });
  expect(
    await ana.crm.createDeliverable(website.id, { title: "Home", nodeId: bensPrivate.id }),
  ).toEqual({ status: "invalid_file" });
  expect(await ana.crm.createDeliverable(website.id, { title: "Home", nodeId: folder })).toEqual({
    status: "invalid_file",
  });
  const made = ok(
    await ana.crm.createDeliverable(website.id, { title: "Home", nodeId: shared.id }),
  ).deliverable;
  expect(await ana.crm.updateDeliverable(made.id, { nodeId: bensPrivate.id })).toEqual({
    status: "invalid_file",
  });
  expect(ok(await ana.crm.plan(website.id)).plan.deliverables[0]?.nodeId).toBe(shared.id);
});

test("a moved milestone lands where it was dropped, and deleting one keeps its deliverables", async () => {
  const { ana } = await team("plan-order");
  const deal = ok(await ana.crm.createDeal({ name: "Launch" })).deal;
  const titles = ["Discovery", "Design", "Build", "Ship"];
  const made = [];
  for (const title of titles) {
    made.push(ok(await ana.crm.createMilestone(deal.id, { title })).milestone);
  }
  const moves = await Promise.all([
    ana.crm.updateMilestone(made[2]!.id, { position: 3 }),
    ana.crm.updateMilestone(made[0]!.id, { position: 3 }),
  ]);
  expect(moves.map((m) => m.status)).toEqual(["ok", "ok"]);
  ok(await ana.crm.updateMilestone(made[0]!.id, { position: 0 }));
  ok(await ana.crm.updateMilestone(made[2]!.id, { position: 2 }));
  ok(await ana.crm.updateMilestone(made[3]!.id, { position: 0 }));
  const order = async () =>
    ok(await ana.crm.plan(deal.id)).plan.milestones.map((m) => [m.title, m.position]);
  expect(await order()).toEqual([
    ["Ship", 0],
    ["Discovery", 1],
    ["Design", 2],
    ["Build", 3],
  ]);

  const done = ok(await ana.crm.updateMilestone(made[1]!.id, { status: "done" })).milestone;
  expect(done.completedAt).toBeInstanceOf(Date);
  const reopened = ok(
    await ana.crm.updateMilestone(made[1]!.id, { status: "in_progress" }),
  ).milestone;
  expect(reopened.completedAt).toBeNull();

  const deliverable = ok(
    await ana.crm.createDeliverable(deal.id, { title: "Wireframes", milestoneId: made[1]!.id }),
  ).deliverable;
  ok(await ana.crm.deleteMilestone(made[1]!.id));
  const plan = ok(await ana.crm.plan(deal.id)).plan;
  expect(plan.deliverables).toMatchObject([{ id: deliverable.id, milestoneId: null }]);
  expect(plan.milestones.map((m) => m.title)).toEqual(["Ship", "Discovery", "Build"]);
});

test("a full plan refuses one more milestone instead of hiding it", async () => {
  const { org, ana } = await team("plan-full");
  const deal = ok(await ana.crm.createDeal({ name: "Big" })).deal;
  await db.insert(crmMilestones).values(
    Array.from({ length: 199 }, (_, position) => ({
      orgId: org.id,
      dealId: deal.id,
      title: `M${position}`,
      position,
    })),
  );
  ok(await ana.crm.createMilestone(deal.id, { title: "Last" }));
  expect(await ana.crm.createMilestone(deal.id, { title: "One more" })).toEqual({
    status: "plan_full",
  });
  expect(ok(await ana.crm.plan(deal.id)).plan.milestones).toHaveLength(200);
});

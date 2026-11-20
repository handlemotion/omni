import type { Client } from "@modelcontextprotocol/client";
import { forMember } from "@omni/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";
import { connectAgent } from "./mcp-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: CrmStack;
beforeAll(async () => {
  stack = await startCrmStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const CRM = "openid mail:read crm:read crm:write";

async function call<T = Record<string, unknown>>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const answer = await agent.callTool({ name, arguments: args });
  if (answer.isError) throw new Error(JSON.stringify(answer.content));
  return answer.structuredContent as T;
}

test("an agent plans a project and reads the plan back on the deal", async () => {
  const org = await stack.company("agentplan");
  const ana = await stack.member(org.id, "owner");
  const crm = forMember(stack.db, ana.id).crm;
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });
  const deal = await crm.createDeal({ name: "Rebrand" });
  const other = await crm.createDeal({ name: "Other" });
  if (deal.status !== "ok" || other.status !== "ok") throw new Error("seed");

  const { milestone } = await call<{ milestone: { id: string } }>(agent, "crm_write", {
    milestone: { deal: deal.deal.id, title: "Discovery", target_on: "2026-12-15" },
  });
  await call(agent, "crm_write", {
    deliverable: {
      deal: deal.deal.id,
      title: "Moodboard",
      milestone: milestone.id,
      client_visible: true,
    },
  });
  const wrong = await agent.callTool({
    name: "crm_write",
    arguments: { deliverable: { deal: other.deal.id, title: "x", milestone: milestone.id } },
  });
  expect(wrong.isError).toBe(true);
  expect((wrong.content as { text: string }[])[0]!.text).toContain("not on this deal");

  const read = await call<{ deals: { plan: Record<string, unknown> }[] }>(agent, "crm_fetch", {
    records: [{ kind: "deal", id: deal.deal.id }],
  });
  expect(read.deals[0]!.plan).toMatchObject({
    milestones: [{ title: "Discovery", target_on: "2026-12-15", status: "planned" }],
    deliverables: [{ title: "Moodboard", milestone_id: milestone.id, client_visible: true }],
  });
});

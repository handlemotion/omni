import type { Client } from "@modelcontextprotocol/client";
import { forMember, schema } from "@omni/db";
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

type Page = { deals: { name: string }[]; next_cursor: string | null };

test("crm_search pages through every deal once, then says there are no more", async () => {
  const org = await stack.company("agentpages");
  const ana = await stack.member(org.id, "owner");
  const crm = forMember(stack.db, ana.id).crm;
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  for (const name of names) await crm.createDeal({ name });
  await crm.createCompany({ name: "Acme" });
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });

  const seen: string[] = [];
  let page = await call<Page>(agent, "crm_search", { kind: "deal", limit: 2 });
  seen.push(...page.deals.map((d) => d.name));
  while (page.next_cursor) {
    page = await call<Page>(agent, "crm_search", {
      kind: "deal",
      limit: 2,
      cursor: page.next_cursor,
    });
    seen.push(...page.deals.map((d) => d.name));
  }
  expect(seen).toEqual(names);

  const forged = await agent.callTool({
    name: "crm_search",
    arguments: { kind: "deal", cursor: "not-a-cursor" },
  });
  expect(forged.isError).toBe(true);
  expect((forged.content as { text: string }[])[0]!.text).toContain("not one `crm_search` gave");
});

test("a filtered company search pages through name and domain matches, each once", async () => {
  const org = await stack.company("agentdomains");
  const ana = await stack.member(org.id, "owner");
  const crm = forMember(stack.db, ana.id).crm;
  await crm.createCompany({ name: "Alpha One" });
  await crm.createCompany({ name: "Alpha Two", domains: ["alpha.io"] });
  await crm.createCompany({ name: "Zeta", domains: ["alphazeta.com"] });
  await crm.createCompany({ name: "Omega" });
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });

  type Companies = { companies: { name: string }[]; next_cursor: string | null };
  const ask = { kind: "company", query: "alpha", archived: "include", limit: 1 };
  const seen: string[] = [];
  let page = await call<Companies>(agent, "crm_search", ask);
  seen.push(...page.companies.map((c) => c.name));
  while (page.next_cursor) {
    page = await call<Companies>(agent, "crm_search", { ...ask, cursor: page.next_cursor });
    seen.push(...page.companies.map((c) => c.name));
  }
  expect(seen).toEqual(["Alpha One", "Alpha Two", "Zeta"]);
});

test("a retried add with the same idempotency_key writes once and replays the answer", async () => {
  const org = await stack.company("agentretry");
  const ana = await stack.member(org.id, "owner");
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });
  const key = crypto.randomUUID();
  const add = { deal: { name: "Retainer", value_minor: 5_200_000, currency: "MXN" } };

  type Added = { result: string; deal: { id: string }; replayed?: boolean };
  const first = await call<Added>(agent, "crm_write", { ...add, idempotency_key: key });
  const again = await call<Added>(agent, "crm_write", { ...add, idempotency_key: key });
  expect(first.replayed).toBeUndefined();
  expect(again).toMatchObject({ result: "added", replayed: true, deal: { id: first.deal.id } });

  const other = await call<Added>(agent, "crm_write", {
    ...add,
    idempotency_key: crypto.randomUUID(),
  });
  expect(other.deal.id).not.toBe(first.deal.id);
  const listed = await forMember(stack.db, ana.id).crm.listDeals({});
  expect(listed.status === "ok" && listed.deals.length).toBe(2);

  const interrupted = crypto.randomUUID();
  await stack.db.insert(schema.auditEvents).values({
    orgId: org.id,
    actorMemberId: ana.id,
    action: "mcp.crm_write.key",
    subject: interrupted,
    data: { via: "mcp" },
  });
  const unsure = await agent.callTool({
    name: "crm_write",
    arguments: { ...add, idempotency_key: interrupted },
  });
  expect(unsure.isError).toBe(true);
  expect((unsure.content as { text: string }[])[0]!.text).toContain("Check with `crm_search`");
  const after = await forMember(stack.db, ana.id).crm.listDeals({});
  expect(after.status === "ok" && after.deals.length).toBe(2);
});

test("a freelancer's agent lists their project, and the team's agent sees who has access", async () => {
  const org = await stack.company("agentaccess");
  const ana = await stack.member(org.id, "owner");
  const fran = await stack.member(org.id, "freelancer");
  const crm = forMember(stack.db, ana.id).crm;
  const website = await crm.createDeal({ name: "Website" });
  await crm.createDeal({ name: "App" });
  if (website.status !== "ok") throw new Error("seed");
  const granted = await crm.grantProjectAccess(website.deal.id, {
    email: fran.email,
    scope: "freelancer",
  });
  expect(granted.status).toBe("ok");

  const team = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });
  const read = await call<{ deals: { access: unknown }[] }>(team, "crm_fetch", {
    records: [{ kind: "deal", id: website.deal.id }],
  });
  expect(read.deals[0]!.access).toMatchObject([{ email: fran.email, scope: "freelancer" }]);

  const theirs = await connectAgent(stack.worker.url, fran.jar, { scope: CRM });
  const found = await call<{ deals: { name: string }[]; companies: unknown[] }>(
    theirs,
    "crm_search",
    {},
  );
  expect(found.deals.map((d) => d.name)).toEqual(["Website"]);
  expect(found.companies).toEqual([]);
});

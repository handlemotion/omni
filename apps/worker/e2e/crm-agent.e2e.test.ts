import type { Client } from "@modelcontextprotocol/client";
import { forMember, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startCrmStack, type CrmStack, type Person } from "./crm-support.ts";
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

interface Row {
  kind: string;
  id: string;
  name: string;
  archived: boolean;
  url: string;
  owner: { name: string | null; address: string } | null;
  expected_close_on?: string | null;
  stage?: { name: string; kind: string };
}
interface Found {
  people: Row[];
  companies: Row[];
  deals: Row[];
}

async function call<T = Record<string, unknown>>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const answer = await agent.callTool({ name, arguments: args });
  if (answer.isError) throw new Error(JSON.stringify(answer.content));
  return answer.structuredContent as T;
}

async function refusal(agent: Client, name: string, args: Record<string, unknown>) {
  const answer = await agent.callTool({ name, arguments: args });
  expect(answer.isError).toBe(true);
  return (answer.content as { text: string }[])[0]!.text;
}

const names = (rows: Row[]) => rows.map((r) => r.name).toSorted();

async function workspace(slug: string) {
  const org = await stack.company(slug);
  const ana: Person = await stack.member(org.id, "owner");
  const ben: Person = await stack.member(org.id);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });
  return { org, ana, ben, agent, crm: forMember(stack.db, ana.id).crm };
}

describe("records", () => {
  test("an agent archives a company, finds it only when asked, and restores it", async () => {
    const { org, agent, crm } = await workspace("agentarchive");
    const kept = await crm.createCompany({ name: "Keeper Co" });
    const gone = await crm.createCompany({ name: "Gone Co" });
    if (kept.status !== "ok" || gone.status !== "ok") throw new Error("seed");

    const archived = await call<{ company: Row }>(agent, "crm_write", {
      company: { id: gone.company.id, archived: true },
    });
    expect(archived.company.archived).toBe(true);
    expect(new URL(archived.company.url).pathname).toBe(
      `/${org.slug}/crm/companies/${gone.company.id}`,
    );
    expect((await crm.company(gone.company.id)).status).toBe("ok");

    const live = await call<Found>(agent, "crm_search", { kind: "company" });
    expect(names(live.companies)).toEqual(["Keeper Co"]);
    const byWord = await call<Found>(agent, "crm_search", { query: "Gone" });
    expect(byWord.companies).toEqual([]);
    const only = await call<Found>(agent, "crm_search", {
      kind: "company",
      archived: "only",
    });
    expect(names(only.companies)).toEqual(["Gone Co"]);
    const both = await call<Found>(agent, "crm_search", {
      query: "co",
      archived: "include",
    });
    expect(names(both.companies)).toEqual(["Gone Co", "Keeper Co"]);

    const restored = await call<{ company: Row }>(agent, "crm_write", {
      company: { id: gone.company.id, archived: false },
    });
    expect(restored.company.archived).toBe(false);
    const back = await call<Found>(agent, "crm_search", { kind: "company" });
    expect(names(back.companies)).toEqual(["Gone Co", "Keeper Co"]);

    const events = await crm.events({ companyId: gone.company.id });
    if (events.status !== "ok") throw new Error("events");
    expect(events.items.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["archived", "restored"]),
    );
    expect(
      await refusal(agent, "crm_write", {
        company: { name: "New", archived: true },
      }),
    ).toMatch(/give its `id`/);
  });

  test("an agent gives people and companies to a teammate and finds them by owner", async () => {
    const { agent, ben, crm } = await workspace("agentowner");
    const added = await call<{ person: Row }>(agent, "crm_write", {
      person: { name: "Lia Ortiz", email: "lia@ortiz.test", owner: ben.email },
    });
    expect(added.person.owner?.address).toBe(ben.email);
    const company = await call<{ company: Row }>(agent, "crm_write", {
      company: { name: "Ortiz Labs" },
    });
    expect(company.company.owner).not.toBeNull();
    await call(agent, "crm_write", {
      company: { id: company.company.id, owner: ben.email },
    });
    await crm.addPerson({ name: "Nobody Owns", address: "no@owner.test" });

    const bens = await call<Found>(agent, "crm_search", { owner: ben.email });
    expect(names(bens.people)).toEqual(["Lia Ortiz"]);
    expect(names(bens.companies)).toEqual(["Ortiz Labs"]);
    expect(bens.companies[0]!.owner?.address).toBe(ben.email);
    const nobody = await call<Found>(agent, "crm_search", {
      owner: "none",
      kind: "person",
    });
    expect(names(nobody.people)).toEqual(["Nobody Owns"]);

    const cleared = await call<{ person: Row }>(agent, "crm_write", {
      person: { id: added.person.id, owner: null },
    });
    expect(cleared.person.owner).toBeNull();
    expect(
      await refusal(agent, "crm_write", {
        person: { id: added.person.id, owner: "stranger@else.test" },
      }),
    ).toMatch(/not in this workspace/);
  });

  test("a deal's close date comes back on its row and narrows a search", async () => {
    const { agent } = await workspace("agentclose");
    const may = await call<{ deal: Row }>(agent, "crm_write", {
      deal: { name: "May launch", expected_close_on: "2027-05-14" },
    });
    expect(may.deal.expected_close_on).toBe("2027-05-14");
    await call(agent, "crm_write", {
      deal: { name: "June retainer", expected_close_on: "2027-06-02" },
    });
    await call(agent, "crm_write", { deal: { name: "Someday" } });

    const inMay = await call<Found>(agent, "crm_search", {
      close_after: "2027-05-01",
      close_before: "2027-05-31",
    });
    expect(names(inMay.deals)).toEqual(["May launch"]);
    expect(inMay.people).toEqual([]);
    expect(
      await refusal(agent, "crm_search", {
        kind: "person",
        close_after: "2027-05-01",
      }),
    ).toMatch(/only find deals/);
  });

  test("bulk moves deals to a stage, refuses another workspace's deal, and audits each", async () => {
    const { org, agent, crm } = await workspace("agentbulk");
    const elsewhere = await workspace("agentbulkside");
    const ids: string[] = [];
    for (const name of ["Alpha", "Beta"]) {
      const made = await crm.createDeal({ name });
      if (made.status !== "ok") throw new Error("seed");
      ids.push(made.deal.id);
    }
    const theirs = await elsewhere.crm.createDeal({ name: "Theirs" });
    if (theirs.status !== "ok") throw new Error("seed");

    const moved = await call<{
      bulk: { done: string[]; refused: { id: string }[] };
    }>(agent, "crm_write", {
      bulk: { kind: "deal", ids: [...ids, theirs.deal.id], stage: "won" },
    });
    expect(moved.bulk.done.toSorted()).toEqual(ids.toSorted());
    expect(moved.bulk.refused.map((r) => r.id)).toEqual([theirs.deal.id]);

    const won = await call<Found>(agent, "crm_search", { stage_kind: "won" });
    expect(names(won.deals)).toEqual(["Alpha", "Beta"]);
    const untouched = await elsewhere.crm.deal(theirs.deal.id);
    expect(untouched.status === "ok" && untouched.deal.stageKind).toBe("open");

    const audits = await stack.db
      .select({ subject: schema.auditEvents.subject })
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.orgId, org.id), eq(schema.auditEvents.action, "mcp.crm_write")),
      );
    expect(audits.map((a) => a.subject).toSorted()).toEqual(ids.toSorted());

    const archived = await call<{ bulk: { done: string[] } }>(agent, "crm_write", {
      bulk: { kind: "deal", ids, archived: true },
    });
    expect(archived.bulk.done).toHaveLength(2);
    expect((await call<Found>(agent, "crm_search", { kind: "deal" })).deals).toEqual([]);
    expect(
      await refusal(agent, "crm_write", {
        bulk: { kind: "person", ids, stage: "won" },
      }),
    ).toMatch(/Only deals/);
    expect(
      await refusal(agent, "crm_write", {
        bulk: { kind: "deal", ids, archived: false, stage: "won" },
      }),
    ).toMatch(/exactly one/);
  });
});

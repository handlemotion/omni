import type { Client } from "@modelcontextprotocol/client";
import { forMember } from "@omni/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off" } });
}, 120_000);
afterAll(() => stack?.stop());

const CRM = "openid mail:read crm:read crm:write";
const PDF = Buffer.from("%PDF-1.4");

interface FileRow {
  id: string;
  title: string;
  url: string;
}
interface Contract {
  id: string;
  title: string;
  status: string;
  deal_id: string | null;
  document_node_id: string | null;
  effective_on: string | null;
  expires_on: string | null;
  signing: unknown;
}
interface Fetched {
  deals: { files: FileRow[]; folder_id: string | null; contracts: Contract[] }[];
  companies: { files: FileRow[]; contracts: Contract[] }[];
}

async function call<T>(agent: Client, name: string, args: Record<string, unknown>) {
  const answer = await agent.callTool({ name, arguments: args });
  if (answer.isError) throw new Error(JSON.stringify(answer.content));
  return answer.structuredContent as T;
}

async function refusal(agent: Client, args: Record<string, unknown>) {
  const answer = await agent.callTool({ name: "crm_write", arguments: args });
  expect(answer.isError).toBe(true);
  return (answer.content as { text: string }[])[0]!.text;
}

async function workspace(slug: string) {
  const org = await stack.company(`${slug}-${crypto.randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });
  return { org, ana, agent, crm: forMember(stack.db, ana.id).crm };
}

test("an agent links Drive files to a deal where they live, reads them back, and unlinks one", async () => {
  const { org, ana, agent, crm } = await workspace("agentfiles");
  const deal = await crm.createDeal({ name: "Calpolli site" });
  if (deal.status !== "ok") throw new Error("seed");
  const brief = await stack.upload(ana.jar, { space: "shared" }, "brief.pdf", PDF);
  const notes = await stack.upload(ana.jar, { space: "personal" }, "notes.pdf", PDF);

  const linked = await call<{ files: FileRow[] }>(agent, "crm_write", {
    files: { record: { kind: "deal", id: deal.deal.id }, link: [brief.id, notes.id] },
  });
  expect(linked.files.map((f) => f.title).toSorted()).toEqual(["brief.pdf", "notes.pdf"]);
  const briefRow = linked.files.find((f) => f.id === brief.id)!;
  expect(new URL(briefRow.url).pathname).toBe(`/${org.slug}/files/shared`);
  expect(new URL(briefRow.url).searchParams.get("file")).toBe(brief.id);

  const fetched = await call<Fetched>(agent, "crm_fetch", {
    records: [{ kind: "deal", id: deal.deal.id }],
  });
  expect(fetched.deals[0]!.files).toHaveLength(2);
  expect(fetched.deals[0]!.folder_id).toEqual(expect.any(String));

  const unlinked = await call<{ files: FileRow[] }>(agent, "crm_write", {
    files: { record: { kind: "deal", id: deal.deal.id }, unlink: [notes.id] },
  });
  expect(unlinked.files.map((f) => f.id)).toEqual([brief.id]);
  const stillThere = await stack.api(ana.jar, "GET", `/nodes/${notes.id}`);
  expect(stillThere.status).toBe(200);
});

test("an agent cannot link a file it cannot open, from another workspace", async () => {
  const ours = await workspace("agentfilesours");
  const theirs = await workspace("agentfilestheirs");
  const deal = await ours.crm.createDeal({ name: "Ours" });
  if (deal.status !== "ok") throw new Error("seed");
  const secret = await stack.upload(theirs.ana.jar, { space: "shared" }, "secret.pdf", PDF);
  expect(
    await refusal(ours.agent, {
      files: { record: { kind: "deal", id: deal.deal.id }, link: [secret.id] },
    }),
  ).toMatch(/not one you can see/);
  const links = await ours.crm.fileLinks({ dealId: deal.deal.id });
  expect(links.status === "ok" && links.links).toEqual([]);
});

test("an agent drafts a contract on a deal and edits it, but never sends or signs it", async () => {
  const { ana, agent, crm } = await workspace("agentcontract");
  const deal = await crm.createDeal({ name: "UP retainer" });
  if (deal.status !== "ok") throw new Error("seed");
  const msa = await stack.upload(ana.jar, { space: "shared" }, "msa.pdf", PDF);
  const personal = await stack.upload(ana.jar, { space: "personal" }, "draft.pdf", PDF);

  const added = await call<{ contract: Contract }>(agent, "crm_write", {
    contract: { title: "UP MSA", deal_id: deal.deal.id, document_node_id: msa.id },
  });
  expect(added.contract).toMatchObject({
    title: "UP MSA",
    status: "draft",
    deal_id: deal.deal.id,
    document_node_id: msa.id,
    signing: null,
  });
  const id = added.contract.id;
  const dated = await call<{ contract: Contract }>(agent, "crm_write", {
    contract: { id, effective_on: "2027-01-01", expires_on: "2027-12-31" },
  });
  expect(dated.contract).toMatchObject({ effective_on: "2027-01-01", expires_on: "2027-12-31" });

  expect(await refusal(agent, { contract: { id, effective_on: "2028-01-01" } })).toMatch(
    /cannot expire before it starts/,
  );
  expect(await refusal(agent, { contract: { id, document_node_id: personal.id } })).toMatch(
    /file in Shared/,
  );
  await agent.callTool({ name: "crm_write", arguments: { contract: { id, status: "signed" } } });
  const stored = await crm.listContracts({ dealId: deal.deal.id });
  expect(stored.status === "ok" && stored.contracts.map((c) => c.status)).toEqual(["draft"]);

  const fetched = await call<Fetched>(agent, "crm_fetch", {
    records: [{ kind: "deal", id: deal.deal.id }],
  });
  expect(fetched.deals[0]!.contracts.map((c) => [c.title, c.status])).toEqual([
    ["UP MSA", "draft"],
  ]);
});

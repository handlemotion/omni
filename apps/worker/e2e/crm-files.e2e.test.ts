import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import type { CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

async function crm(jar: CookieJar, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/crm${path}`, stack.worker.url), {
    method,
    headers: { cookie: jar.header, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

test("a deal's folder takes an upload, and signing its contract locks the file against /api/storage", async () => {
  const org = await stack.company(`crm-files-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const deal = await crm(ana.jar, "POST", "/deals", { name: "Website" });
  expect(deal.status).toBe(201);
  const dealId = deal.body.deal.id;

  const folders = await Promise.all([
    crm(ana.jar, "POST", `/deals/${dealId}/folder`),
    crm(ana.jar, "POST", `/deals/${dealId}/folder`),
  ]);
  expect(folders.map((answer) => answer.status)).toEqual([200, 200]);
  const nodeId = folders[0].body.nodeId;
  expect(folders[1].body.nodeId).toBe(nodeId);

  const file = await stack.upload(ana.jar, { parentId: nodeId }, "msa.pdf", Buffer.from("%PDF"));
  const made = await crm(ana.jar, "POST", "/contracts", {
    title: "MSA",
    dealId,
    documentNodeId: file.id,
    effectiveOn: "2026-12-01",
  });
  expect(made.status).toBe(201);
  const contractId = made.body.contract.id;
  const signed = await crm(ana.jar, "PATCH", `/contracts/${contractId}`, { status: "signed" });
  expect(signed.status).toBe(200);
  expect(signed.body.contract).toMatchObject({ status: "signed", signedAt: expect.any(String) });

  const renamed = await stack.api(ana.jar, "PATCH", `/nodes/${file.id}`, { name: "x.pdf" });
  const trashed = await stack.api(ana.jar, "DELETE", `/nodes/${file.id}`);
  expect([renamed, trashed].map((a) => [a.status, a.body.code])).toEqual([
    [409, "LOCKED"],
    [409, "LOCKED"],
  ]);
  const deleted = await crm(ana.jar, "DELETE", `/contracts/${contractId}`);
  const dealGone = await crm(ana.jar, "DELETE", `/deals/${dealId}?forever=1`);
  expect([deleted, dealGone].map((a) => [a.status, a.body.code])).toEqual([
    [409, "CONTRACT_SIGNED"],
    [409, "CONTRACT_SIGNED"],
  ]);

  const read = await crm(ana.jar, "GET", `/deals/${dealId}`);
  expect(read.body.contracts).toMatchObject([{ id: contractId, documentNodeId: file.id }]);
  const timeline = await crm(ana.jar, "GET", `/deals/${dealId}/timeline`);
  const contractItems = timeline.body.items.filter(
    (item: { kind: string }) => item.kind === "contract",
  );
  expect(contractItems.map((item: { contract: object }) => item.contract)).toMatchObject([
    { contractId, change: "status", status: "signed" },
    { contractId, change: "created", status: "draft" },
  ]);
  expect(
    timeline.body.items.filter((item: { kind: string; event?: { kind: string } }) =>
      item.event?.kind.startsWith("contract_"),
    ),
  ).toEqual([]);
});

test("a deal links Drive files where they live, and each member sees only the ones they can open", async () => {
  const org = await stack.company(`crm-links-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const ben = await stack.member(org.id, "member");
  const dealId = (await crm(ana.jar, "POST", "/deals", { name: "Rebrand" })).body.deal.id;

  const briefs = await stack.api(ana.jar, "POST", "/folders", {
    space: "shared",
    name: "Briefs",
  });
  const brief = await stack.upload(
    ana.jar,
    { parentId: briefs.body.node.id },
    "brief.pdf",
    Buffer.from("%PDF"),
  );
  const notes = await stack.upload(
    ana.jar,
    { space: "personal" },
    "notes.txt",
    Buffer.from("mine"),
  );
  const linked = await Promise.all([
    crm(ana.jar, "POST", `/deals/${dealId}/links`, { nodeIds: [brief.id, notes.id] }),
    crm(ana.jar, "POST", `/deals/${dealId}/links`, { nodeIds: [brief.id] }),
  ]);
  expect(linked.map((answer) => answer.status)).toEqual([200, 200]);
  expect(
    linked[0].body.links.map((link: { node: { id: string } }) => link.node.id).toSorted(),
  ).toEqual([brief.id, notes.id].toSorted());

  const where = await stack.api(ana.jar, "GET", `/nodes/${brief.id}`);
  expect(where.body.node.parentId).toBe(briefs.body.node.id);
  const seen = async (jar: typeof ana.jar) =>
    (await crm(jar, "GET", `/deals/${dealId}/links`)).body.links.map(
      (link: { node: { name: string } }) => link.node.name,
    );
  expect((await seen(ana.jar)).toSorted()).toEqual(["brief.pdf", "notes.txt"]);
  expect(await seen(ben.jar)).toEqual(["brief.pdf"]);

  const benLinksAna = await crm(ben.jar, "POST", `/deals/${dealId}/links`, { nodeIds: [notes.id] });
  expect([benLinksAna.status, benLinksAna.body.code]).toEqual([404, "NOT_FOUND"]);

  await stack.api(ana.jar, "DELETE", `/nodes/${briefs.body.node.id}`);
  expect(await seen(ben.jar)).toEqual([]);
  await stack.api(ana.jar, "POST", `/nodes/${briefs.body.node.id}/restore`);
  expect(await seen(ben.jar)).toEqual(["brief.pdf"]);

  const unlinked = await crm(ben.jar, "DELETE", `/deals/${dealId}/links/${brief.id}`);
  expect(unlinked.status).toBe(204);
  expect(await seen(ben.jar)).toEqual([]);
  expect((await stack.api(ben.jar, "GET", `/nodes/${brief.id}`)).status).toBe(200);

  await stack.api(ana.jar, "DELETE", `/nodes/${notes.id}`);
  await stack.api(ana.jar, "DELETE", `/nodes/${notes.id}?forever=1`);
  const rows = await stack.db
    .select()
    .from(schema.crmFileLinks)
    .where(eq(schema.crmFileLinks.dealId, dealId));
  expect(rows).toEqual([]);
});

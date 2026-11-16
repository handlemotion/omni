// A record's folder and contracts over the real Worker (ADR 0036 decisions 5 and 6): the CRM
// makes the folder, the file goes up through `/api/storage`, and signing the contract locks it
// there. One flow proves the two modules connect.
import { randomUUID } from "node:crypto";
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

// Catches: two folders from two first calls over HTTP, a contract signed without its file being
// locked in Storage (or a lock Storage's routes do not honour), and a signed contract deleted
// through the API.
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

  // The deal reads with its contract, and its timeline shows the contract's own items.
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

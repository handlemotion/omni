import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN } });
});
afterAll(() => stack?.stop());

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n");
const SIGNED = Buffer.from("%PDF-1.7\n% signed by both sides\ntrailer\n%%EOF\n");
const DAILY_CRON = "47 3 * * *";

async function crm(person: Person, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/crm${path}`, stack.worker.url), {
    method,
    headers: {
      cookie: person.jar.header,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function dealWithDraft(contract: Record<string, unknown> = {}) {
  const org = await stack.company(`studio-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const company = await crm(ana, "POST", "/companies", { name: "Universidad" });
  const deal = await crm(ana, "POST", "/deals", {
    name: "Calpolli",
    companyId: company.body.company.id,
  });
  const dealId: string = deal.body.deal.id;
  const folder = await crm(ana, "POST", `/deals/${dealId}/folder`);
  const folderId: string = folder.body.nodeId;
  const draft = await stack.upload(
    ana.jar,
    { parentId: folderId },
    "Contrato.pdf",
    PDF,
    "application/pdf",
  );
  const made = await crm(ana, "POST", "/contracts", {
    dealId,
    title: "Contrato de servicios",
    documentNodeId: draft.id,
    ...contract,
  });
  expect(made.status).toBe(201);
  const signedCopy = () =>
    stack.upload(
      ana.jar,
      { parentId: folderId },
      "Contrato firmado.pdf",
      SIGNED,
      "application/pdf",
    );
  return {
    org,
    ana,
    dealId,
    folderId,
    draft,
    contractId: made.body.contract.id as string,
    signedCopy,
  };
}

const statusEvents = (orgId: string) =>
  stack.db
    .select({ data: schema.crmEvents.data })
    .from(schema.crmEvents)
    .where(
      and(eq(schema.crmEvents.orgId, orgId), eq(schema.crmEvents.kind, "contract_status_changed")),
    )
    .orderBy(asc(schema.crmEvents.createdAt), asc(schema.crmEvents.id));

test("a contract signed on the client's side is recorded with its uploaded copy, who signed and when, and ends on its expiry", async () => {
  const { org, ana, dealId, folderId, draft, contractId, signedCopy } = await dealWithDraft({
    expiresOn: "2030-12-31",
  });
  expect((await crm(ana, "PATCH", `/contracts/${contractId}`, { status: "sent" })).status).toBe(
    200,
  );
  const copy = await signedCopy();

  const recorded = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: copy.id,
    signedAt: "2026-11-18T17:00:00.000Z",
    signers: [
      { name: "Rodrigo Jiménez", email: "Rodrigo@Studio.test" },
      { name: "Legal UP", email: null },
    ],
  });
  expect(recorded.status).toBe(200);
  expect(recorded.body.contract).toMatchObject({
    status: "signed",
    documentNodeId: draft.id,
    signedNodeId: copy.id,
    signedAt: "2026-11-18T17:00:00.000Z",
    signedBy: [
      { name: "Rodrigo Jiménez", email: "rodrigo@studio.test" },
      { name: "Legal UP", email: null },
    ],
    signing: null,
  });
  const inFolder = await stack.api(ana.jar, "GET", `/nodes?parent=${folderId}`);
  const locked = new Map(
    inFolder.body.nodes.map((n: { id: string; lockedAt: string | null }) => [n.id, n.lockedAt]),
  );
  expect(locked.get(copy.id)).toEqual(expect.any(String));
  expect(locked.get(draft.id)).toEqual(expect.any(String));

  const again = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: draft.id,
    signers: [],
  });
  expect(again.body.code).toBe("CONTRACT_SIGNED");
  expect((await statusEvents(org.id)).map((e) => [e.data.from, e.data.to])).toEqual([
    ["draft", "sent"],
    ["sent", "signed"],
  ]);

  await stack.db
    .update(schema.crmContracts)
    .set({ expiresOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) })
    .where(eq(schema.crmContracts.id, contractId));
  expect((await stack.worker.server.getWorker().scheduled({ cron: DAILY_CRON })).outcome).toBe(
    "ok",
  );
  const listed = await crm(ana, "GET", `/contracts?deal=${dealId}`);
  expect(listed.body.contracts).toMatchObject([
    { id: contractId, status: "ended", signedNodeId: copy.id },
  ]);
});

test("a contract marked signed by hand takes its signed copy later and keeps its signing date", async () => {
  const { org, ana, contractId, signedCopy } = await dealWithDraft();
  const marked = await crm(ana, "PATCH", `/contracts/${contractId}`, {
    status: "signed",
    signedAt: "2026-11-02T10:00:00.000Z",
  });
  expect(marked.status).toBe(200);
  const copy = await signedCopy();
  const recorded = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: copy.id,
    signers: [{ name: "Legal UP" }],
  });
  expect(recorded.body.contract).toMatchObject({
    status: "signed",
    signedAt: "2026-11-02T10:00:00.000Z",
    signedNodeId: copy.id,
    signedBy: [{ name: "Legal UP", email: null }],
  });
  expect(await statusEvents(org.id)).toHaveLength(1);
});

test("a signed copy is refused while the contract is out from Omni, from the future, when not a PDF, or outside Shared, and nothing changes", async () => {
  const { ana, dealId, folderId, contractId, signedCopy } = await dealWithDraft();
  const copy = await signedCopy();

  const tomorrow = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const future = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: copy.id,
    signedAt: tomorrow,
    signers: [],
  });
  expect(future.body).toMatchObject({ code: "BAD_REQUEST", param: "signedAt" });

  const sheet = await stack.upload(
    ana.jar,
    { parentId: folderId },
    "Firmas.csv",
    Buffer.from("name,signed\nUP,yes\n"),
    "text/csv",
  );
  const notPdf = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: sheet.id,
    signers: [],
  });
  expect(notPdf.body).toMatchObject({ code: "BAD_REQUEST", param: "nodeId" });

  const mine = await stack.upload(ana.jar, { space: "personal" }, "Mío.pdf", SIGNED);
  const personal = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: mine.id,
    signers: [],
  });
  expect(personal.body).toMatchObject({ code: "BAD_REQUEST", param: "nodeId" });

  const sent = await crm(ana, "POST", `/contracts/${contractId}/send`, {
    signers: [{ email: `legal-${randomUUID().slice(0, 8)}@client.test`, name: "Legal" }],
  });
  expect(sent.status).toBe(200);
  const open = await crm(ana, "POST", `/contracts/${contractId}/signed-copy`, {
    nodeId: copy.id,
    signers: [],
  });
  expect(open.body.code).toBe("SIGNATURE_OPEN");

  const listed = await crm(ana, "GET", `/contracts?deal=${dealId}`);
  expect(listed.body.contracts[0]).toMatchObject({ status: "sent", signedNodeId: null });
  const inFolder = await stack.api(ana.jar, "GET", `/nodes?parent=${folderId}`);
  expect(inFolder.body.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: copy.id, lockedAt: null })]),
  );
});

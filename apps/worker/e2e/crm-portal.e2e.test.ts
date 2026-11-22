import { randomUUID } from "node:crypto";
import { portalProjectResponseSchema } from "@omni/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { CookieJar, signIn, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN } });
});
afterAll(() => stack?.stop());

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n");
const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@client.test`;

async function call(jar: CookieJar, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, stack.worker.url), {
    method,
    headers: {
      cookie: jar.header,
      origin: WEB_ORIGIN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  return jar;
}

test("a client signs in with no workspace and reaches only their project on the portal", async () => {
  const org = await stack.company(`studio-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const deal = async (name: string) =>
    (await call(ana.jar, "POST", "/crm/deals", { name })).body.deal.id as string;
  const website = await deal("Website");
  const app = await deal("App");
  const bob = address("bob");
  const carol = address("carol");

  const folderId = (await call(ana.jar, "POST", `/crm/deals/${website}/folder`)).body.nodeId;
  const file = await stack.upload(
    ana.jar,
    { parentId: folderId },
    "sow.pdf",
    PDF,
    "application/pdf",
  );
  const contract = await call(ana.jar, "POST", "/crm/contracts", {
    dealId: website,
    title: "Services agreement",
    documentNodeId: file.id,
  });
  const sent = await call(ana.jar, "POST", `/crm/contracts/${contract.body.contract.id}/send`, {
    signers: [
      { email: bob, name: "Bob Client" },
      { email: carol, name: "Carol Client" },
    ],
  });
  expect(sent.status).toBe(200);
  const requestId = sent.body.contract.signing.requestId;
  const milestone = await call(ana.jar, "POST", `/crm/deals/${website}/milestones`, {
    title: "Design",
    targetOn: "2026-12-15",
  });
  const deliverable = await call(ana.jar, "POST", `/crm/deals/${website}/deliverables`, {
    title: "Homepage",
    milestoneId: milestone.body.milestone.id,
    status: "in_review",
    clientVisible: true,
  });
  await call(ana.jar, "POST", `/crm/deals/${website}/deliverables`, { title: "Margins" });
  const added = await call(
    ana.jar,
    "PUT",
    `/crm/deals/${website}/access/${encodeURIComponent(bob)}`,
    {
      scope: "client",
    },
  );
  expect(added.status).toBe(201);

  const bobJar = await signedIn(bob);
  const listed = await call(bobJar, "GET", "/portal/projects");
  expect(listed.body.projects.map((p: { name: string }) => p.name)).toEqual(["Website"]);
  const seen = await call(bobJar, "GET", `/portal/projects/${website}`);
  expect(seen.status).toBe(200);
  const detail = portalProjectResponseSchema.parse(seen.body);
  expect(detail.milestones).toMatchObject([{ title: "Design", targetOn: "2026-12-15" }]);
  expect(detail.deliverables.map((d) => d.title)).toEqual(["Homepage"]);
  expect(detail.contracts).toMatchObject([
    { title: "Services agreement", status: "sent", signingRequestId: requestId },
  ]);
  expect(detail.folder).toMatchObject({ files: [] });

  const approved = await call(
    bobJar,
    "POST",
    `/portal/projects/${website}/deliverables/${deliverable.body.deliverable.id}/review`,
    { decision: "approve" },
  );
  expect(approved.body.deliverables[0]).toMatchObject({ status: "approved", reviewedByEmail: bob });

  expect((await call(bobJar, "GET", `/portal/projects/${app}`)).status).toBe(404);
  const ownCrm = await call(bobJar, "GET", "/crm/deals");
  expect(JSON.stringify(ownCrm.body)).not.toContain("Website");
  expect((await call(bobJar, "GET", `/crm/deals/${website}`)).status).toBeGreaterThanOrEqual(400);

  const carolJar = await signedIn(carol);
  expect((await call(carolJar, "GET", "/portal/projects")).body.projects).toEqual([]);
  expect((await call(carolJar, "GET", `/portal/projects/${website}`)).status).toBe(404);
  expect((await call(new CookieJar(), "GET", "/portal/projects")).status).toBe(401);
});

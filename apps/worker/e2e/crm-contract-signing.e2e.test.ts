import { randomUUID } from "node:crypto";
import { STORAGE_SIGNING_CONSENT } from "@omni/contracts";
import { schema } from "@omni/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, sentMail, signIn, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN } });
});
afterAll(() => stack?.stop());

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n");
const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@client.test`;

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

async function draftOnDeal(
  bytes = PDF,
  name = "Services agreement.pdf",
  mimeType = "application/pdf",
) {
  const org = await stack.company(`studio-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const company = await crm(ana.jar, "POST", "/companies", { name: "Initech" });
  const deal = await crm(ana.jar, "POST", "/deals", {
    name: "Website rebuild",
    companyId: company.body.company.id,
  });
  expect(deal.status).toBe(201);
  const dealId: string = deal.body.deal.id;
  const folder = await crm(ana.jar, "POST", `/deals/${dealId}/folder`);
  const folderId: string = folder.body.nodeId;
  const file = await stack.upload(ana.jar, { parentId: folderId }, name, bytes, mimeType);
  const made = await crm(ana.jar, "POST", "/contracts", {
    dealId,
    title: "Services agreement",
    documentNodeId: file.id,
    expiresOn: "2030-12-31",
  });
  expect(made.status).toBe(201);
  return { org, ana, dealId, folderId, file, contractId: made.body.contract.id as string };
}

async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  return jar;
}

async function signAs(email: string, requestId: string) {
  const jar = await signedIn(email);
  const opened = await stack.get(jar, `/signing/${requestId}/content`);
  expect(opened.status).toBe(200);
  await opened.body?.cancel();
  expect((await stack.api(jar, "POST", `/signing/${requestId}/code`)).status).toBe(200);
  const mails = (await sentMail(stack.worker, email)).filter((m) =>
    m.subject.startsWith("Your code"),
  );
  const code = mails.at(-1)?.text.match(/^(\d{6})$/m)?.[1];
  const signed = await stack.api(jar, "POST", `/signing/${requestId}/sign`, {
    code,
    typedName: email.split("@")[0],
    consentVersion: STORAGE_SIGNING_CONSENT.version,
  });
  expect(signed.status).toBe(200);
  return jar;
}

async function sealed(person: Person, fileId: string) {
  for (let tries = 0; tries < 50; tries++) {
    const listed = await stack.api(person.jar, "GET", `/files/${fileId}/signatures`);
    const request = listed.body.requests.find((r: { status: string }) => r.status === "completed");
    if (request?.sealedNodeId) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("never sealed");
}

const contractOf = async (person: Person, dealId: string, contractId: string) => {
  const listed = await crm(person.jar, "GET", `/contracts?deal=${dealId}`);
  return listed.body.contracts.find((c: { id: string }) => c.id === contractId);
};

test("a contract sent from its deal is signed by each client, and the signed copy lands in the deal's folder", async () => {
  const { org, ana, dealId, folderId, file, contractId } = await draftOnDeal();
  const bob = address("bob");
  const carol = address("carol");

  const sent = await crm(ana.jar, "POST", `/contracts/${contractId}/send`, {
    signers: [
      { email: bob, name: "Bob Client" },
      { email: carol, name: "Carol Client" },
    ],
  });
  expect(sent.status).toBe(200);
  const requestId: string = sent.body.contract.signing.requestId;
  expect(sent.body.contract).toMatchObject({
    status: "sent",
    signing: {
      status: "sent",
      signers: [
        { email: bob, name: "Bob Client", viewedAt: null, signedAt: null },
        { email: carol, name: "Carol Client", viewedAt: null, signedAt: null },
      ],
    },
  });
  const [invite] = await sentMail(stack.worker, bob);
  expect(invite!.text).toMatch(new RegExp(`${WEB_ORIGIN}/sign/${requestId}#t=[\\w-]{43}\\n`));

  const moved = await crm(ana.jar, "PATCH", `/contracts/${contractId}`, { status: "signed" });
  expect(moved.body.code).toBe("SIGNATURE_OPEN");
  expect((await crm(ana.jar, "DELETE", `/contracts/${contractId}`)).body.code).toBe(
    "SIGNATURE_OPEN",
  );

  await signAs(bob, requestId);
  const halfway = await contractOf(ana, dealId, contractId);
  expect(halfway.status).toBe("sent");
  expect(halfway.signing.signers).toEqual([
    expect.objectContaining({
      email: bob,
      viewedAt: expect.any(String),
      signedAt: expect.any(String),
    }),
    expect.objectContaining({ email: carol, viewedAt: null, signedAt: null }),
  ]);

  await signAs(carol, requestId);
  const request = await sealed(ana, file.id);

  for (let run = 0; run < 2; run++) expect(await stack.cron("* * * * *")).toBe("ok");
  const signed = await contractOf(ana, dealId, contractId);
  expect(signed).toMatchObject({
    status: "signed",
    signedAt: request.completedAt,
    signedNodeId: request.sealedNodeId,
    signing: { status: "completed", sealedNodeId: request.sealedNodeId },
  });
  const inFolder = await stack.api(ana.jar, "GET", `/nodes?parent=${folderId}`);
  expect(inFolder.body.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: request.sealedNodeId,
        name: "Services agreement (signed).pdf",
        lockedAt: expect.any(String),
      }),
    ]),
  );

  const events = await stack.db
    .select({ data: schema.crmEvents.data })
    .from(schema.crmEvents)
    .where(
      and(eq(schema.crmEvents.orgId, org.id), eq(schema.crmEvents.kind, "contract_status_changed")),
    )
    .orderBy(asc(schema.crmEvents.createdAt), asc(schema.crmEvents.id));
  expect(events.map((e) => [e.data.from, e.data.to])).toEqual([
    ["draft", "sent"],
    ["sent", "signed"],
  ]);
});

test("voiding takes the contract back to draft and closes the client's link; a void in Drive settles the same way", async () => {
  const { ana, dealId, contractId } = await draftOnDeal();
  const bob = address("bob");
  const signers = [{ email: bob, name: "Bob Client" }];

  const first = await crm(ana.jar, "POST", `/contracts/${contractId}/send`, { signers });
  const firstRequest: string = first.body.contract.signing.requestId;
  const voided = await crm(ana.jar, "POST", `/contracts/${contractId}/void`);
  expect(voided.status).toBe(200);
  expect(voided.body.contract).toMatchObject({ status: "draft", signing: null });
  const bobJar = await signedIn(bob);
  expect((await stack.api(bobJar, "GET", `/signing/${firstRequest}/content`)).status).toBe(404);

  const again = await crm(ana.jar, "POST", `/contracts/${contractId}/send`, { signers });
  expect(again.status).toBe(200);
  const secondRequest: string = again.body.contract.signing.requestId;
  expect(secondRequest).not.toBe(firstRequest);
  expect((await crm(ana.jar, "POST", `/contracts/${contractId}/send`, { signers })).body.code).toBe(
    "SIGNATURE_OPEN",
  );
  const purge = await crm(ana.jar, "DELETE", `/deals/${dealId}?forever=1`);
  expect(purge.body.code).toBe("CONTRACT_SIGNED");
  expect((await contractOf(ana, dealId, contractId)).status).toBe("sent");

  expect((await stack.api(ana.jar, "POST", `/signatures/${secondRequest}/void`)).status).toBe(200);
  expect((await contractOf(ana, dealId, contractId)).status).toBe("sent");
  expect(await stack.cron("* * * * *")).toBe("ok");
  expect(await contractOf(ana, dealId, contractId)).toMatchObject({
    status: "draft",
    signing: null,
  });
});

test("only a PDF goes out, and a refused send leaves the contract a draft with nothing mailed", async () => {
  const { ana, dealId, contractId } = await draftOnDeal(
    Buffer.from("not a pdf"),
    "notes.txt",
    "text/plain",
  );
  const bob = address("bob");
  const sent = await crm(ana.jar, "POST", `/contracts/${contractId}/send`, {
    signers: [{ email: bob, name: "Bob" }],
  });
  expect(sent.body.code).toBe("NOT_A_PDF");
  expect(await contractOf(ana, dealId, contractId)).toMatchObject({
    status: "draft",
    signing: null,
  });
  expect(await sentMail(stack.worker, bob)).toEqual([]);
});

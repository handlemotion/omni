import { randomUUID } from "node:crypto";
import { STORAGE_SIGNING_CONSENT, type StorageNode } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sha256, startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, sentMail, signIn, WEB_ORIGIN, workerEvents } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN } });
});
afterAll(() => stack?.stop());

const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@outside.test`;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n");

async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  return jar;
}

async function owner() {
  const org = await stack.company(`acme-${randomUUID().slice(0, 8)}`);
  return { org, ana: await stack.member(org.id, "owner") };
}

async function pdf(
  person: Person,
  name = "contract.pdf",
  bytes = PDF,
  mimeType = "application/pdf",
) {
  return stack.upload(person.jar, { space: "shared" }, name, bytes, mimeType);
}

const send = (person: Person, file: StorageNode, signers: { email: string; name: string }[]) =>
  stack.api(person.jar, "POST", `/files/${file.id}/signatures`, { signers });

async function mailedCode(to: string) {
  const mails = (await sentMail(stack.worker, to)).filter((m) => m.subject.startsWith("Your code"));
  const code = mails.at(-1)?.text.match(/^(\d{6})$/m)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
}

const sign = (jar: CookieJar, requestId: string, code: string, typedName: string) =>
  stack.api(jar, "POST", `/signing/${requestId}/sign`, {
    code,
    typedName,
    consentVersion: STORAGE_SIGNING_CONSENT.version,
  });

test("a sent PDF is locked and hashed, each signer signs by mailed code, and the last signature completes it", async () => {
  const { ana } = await owner();
  const file = await pdf(ana);
  const bob = address("bob");
  const carol = address("carol");

  const sent = await send(ana, file, [
    { email: bob.toUpperCase(), name: "Bob Client" },
    { email: carol, name: "Carol Client" },
  ]);
  expect(sent.status).toBe(201);
  const requestId = sent.body.request.id as string;
  expect(sent.body.request).toMatchObject({
    status: "sent",
    documentSha256: sha256(PDF),
    contentVersion: file.contentVersion,
    signers: [
      { email: bob, name: "Bob Client", signedAt: null },
      { email: carol, name: "Carol Client", signedAt: null },
    ],
  });
  const listed = await stack.api(ana.jar, "GET", `/nodes?space=shared`);
  expect(listed.body.nodes).toMatchObject([{ id: file.id, lockedAt: expect.any(String) }]);

  const [invite, ...more] = await sentMail(stack.worker, bob);
  expect(more).toEqual([]);
  expect(invite!.text).toContain(`${WEB_ORIGIN}/sign/${requestId}\n`);

  const eve = await signedIn(address("eve"));
  expect((await stack.api(eve, "GET", `/signing/${requestId}`)).status).toBe(404);
  expect((await stack.get(eve, `/signing/${requestId}/content`)).status).toBe(404);
  expect((await stack.api(eve, "POST", `/signing/${requestId}/code`)).status).toBe(404);

  const bobJar = await signedIn(bob);
  const mine = await stack.api(bobJar, "GET", "/signing");
  expect(mine.body.items).toEqual([
    expect.objectContaining({
      id: requestId,
      fileName: "contract.pdf",
      sentBy: ana.email,
      signers: [
        { name: "Bob Client", signed: false },
        { name: "Carol Client", signed: false },
      ],
      me: { email: bob, name: "Bob Client", signedAt: null },
    }),
  ]);
  const document = await stack.get(bobJar, `/signing/${requestId}/content`);
  expect(Buffer.from(await document.arrayBuffer()).equals(PDF)).toBe(true);

  expect((await sign(bobJar, requestId, "000000", "Bob Client")).body.code).toBe("INVALID_CODE");
  expect((await stack.api(bobJar, "POST", `/signing/${requestId}/code`)).status).toBe(200);
  const code = await mailedCode(bob);
  const wrong = code === "111111" ? "222222" : "111111";
  expect((await sign(bobJar, requestId, wrong, "Bob Client")).status).toBe(400);
  const bobSigned = await sign(bobJar, requestId, code, "Bob Client");
  expect(bobSigned.status).toBe(200);
  expect(bobSigned.body.item).toMatchObject({
    status: "sent",
    me: { signedAt: expect.any(String) },
    signers: [
      { name: "Bob Client", signed: true },
      { name: "Carol Client", signed: false },
    ],
  });
  expect((await sign(bobJar, requestId, code, "Bob Client")).body.code).toBe("ALREADY_SIGNED");

  const carolJar = await signedIn(carol);
  await stack.api(carolJar, "POST", `/signing/${requestId}/code`);
  const carolSigned = await sign(carolJar, requestId, await mailedCode(carol), "Carol C.");
  expect(carolSigned.body.item.status).toBe("completed");

  const trail = await stack.api(ana.jar, "GET", `/files/${file.id}/signatures`);
  const [request] = trail.body.requests;
  expect(request).toMatchObject({
    status: "completed",
    completedAt: expect.any(String),
    signers: [
      { email: bob, typedName: "Bob Client", signedAt: expect.any(String) },
      { email: carol, typedName: "Carol C.", signedAt: expect.any(String) },
    ],
  });
  expect(
    request.events.map((event: { kind: string; email: string }) => [event.kind, event.email]),
  ).toEqual([
    ["sent", ana.email],
    ["viewed", bob],
    ["code_sent", bob],
    ["code_verified", bob],
    ["signed", bob],
    ["code_sent", carol],
    ["code_verified", carol],
    ["signed", carol],
    ["completed", carol],
  ]);
  const rows = await stack.db
    .select()
    .from(schema.storageSigners)
    .where(eq(schema.storageSigners.requestId, requestId));
  for (const row of rows) {
    expect(row).toMatchObject({
      documentSha256: sha256(PDF),
      consentVersion: STORAGE_SIGNING_CONSENT.version,
      userId: expect.any(String),
    });
  }
});

test("only a real PDF is sent, once at a time, and a voided request closes to its signer", async () => {
  const { ana } = await owner();
  const bob = address("bob");
  const signers = [{ email: bob, name: "Bob" }];

  const text = await pdf(ana, "notes.txt", Buffer.from("hello"), "text/plain");
  expect((await send(ana, text, signers)).body.code).toBe("NOT_A_PDF");
  const disguised = await pdf(ana, "fake.pdf", Buffer.from("hello, not a pdf"));
  expect((await send(ana, disguised, signers)).body.code).toBe("NOT_A_PDF");
  const after = await stack.api(ana.jar, "GET", `/nodes?space=shared`);
  expect(after.body.nodes.map((node: StorageNode) => node.lockedAt)).toEqual([null, null]);

  const file = await pdf(ana);
  const first = await send(ana, file, signers);
  expect(first.status).toBe(201);
  expect((await send(ana, file, signers)).body.code).toBe("SIGNATURE_OPEN");

  const requestId = first.body.request.id as string;
  const voided = await stack.api(ana.jar, "POST", `/signatures/${requestId}/void`);
  expect(voided.body.request).toMatchObject({ status: "voided", voidedAt: expect.any(String) });
  expect((await stack.api(ana.jar, "POST", `/signatures/${requestId}/void`)).body.code).toBe(
    "SIGNATURE_CLOSED",
  );

  const bobJar = await signedIn(bob);
  expect((await stack.get(bobJar, `/signing/${requestId}/content`)).status).toBe(404);
  expect((await stack.api(bobJar, "POST", `/signing/${requestId}/code`)).body.code).toBe(
    "SIGNATURE_CLOSED",
  );

  expect((await send(ana, file, signers)).status).toBe(201);
});

async function sealedRequest(person: Person, fileId: string) {
  for (let tries = 0; tries < 50; tries++) {
    const listed = await stack.api(person.jar, "GET", `/files/${fileId}/signatures`);
    const [request] = listed.body.requests;
    if (request?.sealedNodeId) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = workerEvents(stack.worker).filter((line) => String(line.event).includes("seal"));
  throw new Error(`never sealed: ${JSON.stringify(logs)}`);
}

const signedMail = async (to: string) =>
  (await sentMail(stack.worker, to)).filter((mail) => mail.subject.endsWith("is signed"));

async function signAll(person: Person, file: StorageNode, signers: string[]) {
  const sent = await send(
    person,
    file,
    signers.map((email) => ({ email, name: email.split("@")[0]! })),
  );
  const requestId = sent.body.request.id as string;
  const jars: CookieJar[] = [];
  for (const email of signers) {
    const jar = await signedIn(email);
    await stack.api(jar, "POST", `/signing/${requestId}/code`);
    expect((await sign(jar, requestId, await mailedCode(email), email)).status).toBe(200);
    jars.push(jar);
  }
  return { requestId, jars };
}

test("the last signature seals: a locked signed copy beside the original with an audit page, mailed once to everyone", async () => {
  const { org, ana } = await owner();
  const doc = await PDFDocument.create();
  doc.addPage().drawText("Services agreement");
  const original = Buffer.from(await doc.save());
  const file = await pdf(ana, "contract.pdf", original);
  const bob = address("bob");
  const { requestId, jars } = await signAll(ana, file, [bob]);

  const request = await sealedRequest(ana, file.id);
  const listed = await stack.api(ana.jar, "GET", `/nodes?space=shared`);
  expect(listed.body.nodes).toMatchObject([
    { id: request.sealedNodeId, name: "contract (signed).pdf", lockedAt: expect.any(String) },
    { id: file.id, name: "contract.pdf", lockedAt: expect.any(String) },
  ]);
  const sealedBytes = Buffer.from(
    await (await stack.download(ana.jar, request.sealedNodeId)).arrayBuffer(),
  );
  expect(sha256(sealedBytes)).toBe(request.sealedSha256);
  expect((await PDFDocument.load(sealedBytes)).getPageCount()).toBe(2);
  const kept = Buffer.from(await (await stack.download(ana.jar, file.id)).arrayBuffer());
  expect(kept.equals(original)).toBe(true);
  expect(await stack.usedBytes(org.id)).toBe(original.length + sealedBytes.length);

  const signerView = await stack.api(jars[0]!, "GET", `/signing/${requestId}`);
  expect(signerView.body.item.sealed).toBe(true);
  const fetched = await stack.get(jars[0]!, `/signing/${requestId}/sealed`);
  expect(Buffer.from(await fetched.arrayBuffer()).equals(sealedBytes)).toBe(true);
  expect(await signedMail(bob)).toHaveLength(1);
  expect(await signedMail(ana.email)).toHaveLength(1);

  expect(await stack.cron("* * * * *")).toBe("ok");
  expect((await stack.api(ana.jar, "GET", `/nodes?space=shared`)).body.nodes).toHaveLength(2);
  expect(await signedMail(bob)).toHaveLength(1);

  expect((await stack.api(ana.jar, "DELETE", `/nodes/${request.sealedNodeId}/lock`)).status).toBe(
    200,
  );
  const forged = Buffer.from("%PDF-1.7 a different certificate");
  const replace = async (sha256?: string) => {
    const opened = await stack.api(ana.jar, "POST", `/files/${request.sealedNodeId}/versions`, {
      size: forged.length,
      mimeType: "application/pdf",
      sha256,
    });
    await (await stack.putPart(ana.jar, opened.body.upload.id, 1, forged)).body?.cancel();
    return stack.api(ana.jar, "POST", `/uploads/${opened.body.upload.id}/complete`);
  };
  const claimed = await replace(request.sealedSha256);
  expect([claimed.status, claimed.body.code]).toEqual([422, "CHECKSUM_MISMATCH"]);
  const replaced = await replace();
  expect(replaced.status).toBe(200);
  expect((await stack.get(jars[0]!, `/signing/${requestId}/sealed`)).status).toBe(404);
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${request.sealedNodeId}`)).status).toBe(200);
  const gone = await stack.api(ana.jar, "DELETE", `/nodes/${request.sealedNodeId}?forever=1`);
  expect(gone.status).toBe(204);
  expect(await stack.cron("* * * * *")).toBe("ok");
  expect((await stack.api(ana.jar, "GET", `/nodes?space=shared`)).body.nodes).toHaveLength(1);
  expect(await signedMail(bob)).toHaveLength(1);

  const broken = await pdf(ana, "broken.pdf", Buffer.from("%PDF-1.7 not really"));
  await signAll(ana, broken, [address("carol")]);
  const brokenSeal = await sealedRequest(ana, broken.id);
  const certificate = await stack.download(ana.jar, brokenSeal.sealedNodeId);
  const pages = (await PDFDocument.load(await certificate.arrayBuffer())).getPageCount();
  expect(pages).toBe(1);
});

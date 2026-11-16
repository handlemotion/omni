// Signing (ADR 0043 decision 6, the flow of ADR 0037 decision 4) over the real Worker, Postgres,
// local R2 and Email Sending, with real sign-ins: a member sends a PDF, people outside Omni read
// and sign it by address with a mailed code, and the request completes on the last signature.
import { randomUUID } from "node:crypto";
import { STORAGE_SIGNING_CONSENT, type StorageNode } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sha256, startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, sentMail, signIn, WEB_ORIGIN } from "./support.ts";

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

/** The code in the newest signing-code mail to `to`. */
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

// Catches: a hash taken from the uploader's claim instead of the bytes, a file sent without its
// lock, a signer reached by someone the request does not name, another signer's address shown to
// a signer, a signature without the mailed code (or with a wrong one that is not counted), a
// request completed before its last signer, and an audit trail missing a step.
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

  // Someone the request does not name reaches nothing of it.
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

  // No code asked for: nothing to sign with. Then a wrong code, then the mailed one.
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
  // A code is used once, and a signer signs once.
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

// Catches: a file that only claims to be a PDF sent anyway (or locked on the way to refusing),
// one file out to sign twice at once, a voided request a signer can still read or get a code
// for, and a void that leaves no way to send the file again.
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

  // Still locked, and sent again as a new request.
  expect((await send(ana, file, signers)).status).toBe(201);
});

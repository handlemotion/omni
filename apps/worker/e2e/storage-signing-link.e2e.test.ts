import { randomUUID } from "node:crypto";
import { STORAGE_SIGNING_CONSENT } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { CookieJar, sentMail, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN } });
});
afterAll(() => stack?.stop());

const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@outside.test`;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n");

async function sendTo(signers: { email: string; name: string }[], name = "contract.pdf") {
  const org = await stack.company(`acme-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id, "owner");
  const file = await stack.upload(ana.jar, { space: "shared" }, name, PDF, "application/pdf");
  const sent = await stack.api(ana.jar, "POST", `/files/${file.id}/signatures`, { signers });
  expect(sent.status).toBe(201);
  return sent.body.request.id as string;
}

async function linkIn(to: string, requestId: string) {
  const invite = (await sentMail(stack.worker, to)).find((mail) => mail.text.includes(requestId));
  const token = invite?.text.match(new RegExp(`/sign/${requestId}#t=([\\w-]+)`))?.[1];
  if (!token) throw new Error(`no signing link mailed to ${to}`);
  return token;
}

async function openLink(jar: CookieJar, requestId: string, token: string) {
  const response = await fetch(
    new URL(`/api/storage/signing/${requestId}/link`, stack.worker.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    },
  );
  jar.store(response);
  return response;
}

async function mailedCode(to: string) {
  const mails = (await sentMail(stack.worker, to)).filter((m) => m.subject.startsWith("Your code"));
  const code = mails.at(-1)?.text.match(/^(\d{6})$/m)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
}

test("the mail's link opens its request without an account, for that signer only, and signing still takes the mailed code", async () => {
  const bob = address("bob");
  const carol = address("carol");
  const requestId = await sendTo([
    { email: bob, name: "Bob Client" },
    { email: carol, name: "Carol Client" },
  ]);
  const token = await linkIn(bob, requestId);

  const jar = new CookieJar();
  expect((await stack.api(jar, "GET", `/signing/${requestId}`)).status).toBe(401);
  expect((await openLink(jar, requestId, "x".repeat(43))).status).toBe(404);
  expect(jar.cookies.size).toBe(0);

  const opened = await openLink(jar, requestId, token);
  expect(opened.status).toBe(204);
  const cookie = opened.headers.getSetCookie()[0] ?? "";
  expect(cookie).toMatch(new RegExp(`Path=/api/storage/signing/${requestId}`));
  expect(cookie).toMatch(/HttpOnly/i);

  const seen = await stack.api(jar, "GET", `/signing/${requestId}`);
  expect(seen.status).toBe(200);
  expect(seen.body.item.me).toEqual({ email: bob, name: "Bob Client", signedAt: null });
  const document = await stack.get(jar, `/signing/${requestId}/content`);
  expect(Buffer.from(await document.arrayBuffer()).equals(PDF)).toBe(true);
  expect((await stack.api(jar, "GET", "/signing")).status).toBe(401);

  const sign = (code: string) =>
    stack.api(jar, "POST", `/signing/${requestId}/sign`, {
      code,
      typedName: "Bob Client",
      consentVersion: STORAGE_SIGNING_CONSENT.version,
    });
  expect((await sign("000000")).body.code).toBe("INVALID_CODE");
  expect((await stack.api(jar, "POST", `/signing/${requestId}/code`)).status).toBe(200);
  const signed = await sign(await mailedCode(bob));
  expect(signed.status).toBe(200);
  expect(signed.body.item.signers).toEqual([
    { name: "Bob Client", signed: true },
    { name: "Carol Client", signed: false },
  ]);

  const [row] = await stack.db
    .select({ userId: schema.storageSigners.userId, typedName: schema.storageSigners.typedName })
    .from(schema.storageSigners)
    .where(eq(schema.storageSigners.email, bob));
  expect(row).toEqual({ userId: null, typedName: "Bob Client" });
  const accounts = await stack.db.select().from(schema.users).where(eq(schema.users.email, bob));
  expect(accounts).toEqual([]);
});

test("a link opens only its own request: not another one sent to the same signer, and not as a co-signer", async () => {
  const bob = address("bob");
  const carol = address("carol");
  const first = await sendTo([
    { email: bob, name: "Bob Client" },
    { email: carol, name: "Carol Client" },
  ]);
  const second = await sendTo([{ email: bob, name: "Bob Client" }], "other.pdf");
  const firstToken = await linkIn(bob, first);

  const jar = new CookieJar();
  expect((await openLink(jar, second, firstToken)).status).toBe(404);
  await openLink(jar, first, firstToken);
  expect((await stack.api(jar, "GET", `/signing/${second}`)).status).toBe(401);
  expect((await stack.get(jar, `/signing/${second}/content`)).status).toBe(401);

  const carolJar = new CookieJar();
  await openLink(carolJar, first, await linkIn(carol, first));
  const carolSees = await stack.api(carolJar, "GET", `/signing/${first}`);
  expect(carolSees.body.item.me.email).toBe(carol);
});

test("a page opened from one signer's link refuses to mail a code or sign once the browser opened a co-signer's link", async () => {
  const bob = address("bob");
  const carol = address("carol");
  const requestId = await sendTo([
    { email: bob, name: "Bob Client" },
    { email: carol, name: "Carol Client" },
  ]);
  const jar = new CookieJar();
  await openLink(jar, requestId, await linkIn(bob, requestId));
  expect((await stack.api(jar, "GET", `/signing/${requestId}`)).body.item.me.email).toBe(bob);
  await openLink(jar, requestId, await linkIn(carol, requestId));

  const asBob = `/signing/${requestId}/code?signer=${encodeURIComponent(bob)}`;
  expect((await stack.api(jar, "POST", asBob)).body.code).toBe("SIGNER_CHANGED");
  const signedAsBob = await stack.api(
    jar,
    "POST",
    `/signing/${requestId}/sign?signer=${encodeURIComponent(bob)}`,
    { code: "123456", typedName: "Bob Client", consentVersion: STORAGE_SIGNING_CONSENT.version },
  );
  expect(signedAsBob.body.code).toBe("SIGNER_CHANGED");
  expect(await sentMail(stack.worker, carol)).toHaveLength(1);

  const asCarol = `/signing/${requestId}/code?signer=${encodeURIComponent(carol.toUpperCase())}`;
  expect((await stack.api(jar, "POST", asCarol)).status).toBe(200);
  expect(await mailedCode(carol)).toMatch(/^\d{6}$/);
});

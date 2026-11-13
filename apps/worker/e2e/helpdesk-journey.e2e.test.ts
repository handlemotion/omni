// The helpdesk's acceptance journey (H4) on the whole local stack: the real Worker, the real mail
// service syncing and sending through GreenMail, Postgres and the S3 gateway. A customer writes
// support@; the team claims, talks in a note, answers with a canned reply and a file, and
// resolves; the customer's mail drives the status the way the plan says it must.
import { randomUUID } from "node:crypto";
import { createS3Store } from "@omni/mail";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  greenmail,
  startOnboardingStack,
  waitFor,
  type OnboardingStack,
} from "./onboarding-stack.ts";
import { createMember, grant, signIn, WEB_ORIGIN } from "./support.ts";

let stack: OnboardingStack;

beforeAll(async () => {
  // The outbox runs every 300 ms, so a send or a resolve reaches GreenMail within the test.
  stack = await startOnboardingStack({ outboxIntervalMs: 300 });
});

afterAll(async () => {
  await stack?.stop();
});

/** The fields this journey reads from the API's answers. */
interface Answer {
  id: string;
  status: string;
  error: string | null;
  changed: boolean;
  notified: string[];
  conversations: { id: string; subject: string }[];
  notifications: { kind: string; threadId: string }[];
  text: string;
  missing: string[];
  actionId: string;
  messageIdHeader: string | null;
}

/** A same-origin web app call with a fresh Idempotency-Key, as the client sends on writes. */
async function call(
  cookie: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
) {
  const response = await fetch(new URL(`/api${path}`, stack.worker.url), {
    method,
    headers: {
      cookie,
      origin: WEB_ORIGIN,
      "content-type": "application/json",
      "idempotency-key": `journey-${randomUUID()}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Answer };
}

async function deliver(mail: {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  headers?: Record<string, string>;
}) {
  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  try {
    await transport.sendMail({
      ...mail,
      ...(mail.inReplyTo ? { references: [mail.inReplyTo] } : {}),
    });
  } finally {
    transport.close();
  }
}

/** Another mail app on the same account (GreenMail accepts any password). */
async function mailApp<T>(user: string, task: (client: ImapFlow) => Promise<T>) {
  const client = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
    secure: false,
    auth: { user, pass: "unused" },
    logger: false,
  });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.logout();
  }
}

/** Subjects of the messages in one IMAP folder (empty when the folder does not exist). */
async function folderSubjects(user: string, path: string) {
  return mailApp(user, async (client) => {
    const exists = (await client.list()).some((folder) => folder.path === path);
    if (!exists) return [];
    const lock = await client.getMailboxLock(path);
    try {
      const subjects: string[] = [];
      for await (const message of client.fetch("1:*", { envelope: true })) {
        subjects.push(message.envelope?.subject ?? "");
      }
      return subjects;
    } catch {
      return []; // an empty folder has no 1:*
    } finally {
      lock.release();
    }
  });
}

test("a customer's mail goes from Unassigned to resolved and archived, with notes, a canned reply and a file", async () => {
  const { db } = stack.database;

  // A workspace whose support@ is on GreenMail, set up the way onboarding does it.
  const owner = await stack.workspaceWithDomain();
  const support = `support@${owner.domain}`;
  const created = await stack.api(owner.jar, "POST", "/onboarding/mailboxes", {
    domainId: owner.domainId,
    localPart: "support",
    login: {
      password: "app-password",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  });
  expect(created).toMatchObject({ status: 200, body: { address: support, created: true } });
  const mailboxId = created.body.mailboxId as string;
  await waitFor(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });
  const ana = owner.jar.header;
  const me = await call(ana, "GET", "/me");
  const anaId = me.body.id as string;
  // Sends go out at once: the undo window is the composer's, not what this journey proves.
  expect((await call(ana, "PATCH", "/preferences", { undoSendSeconds: 0 })).status).toBe(200);

  // Bea is a teammate on the inbox.
  const bea = await createMember(db, owner.orgId, `bea@${owner.domain}`);
  await grant(db, owner.orgId, mailboxId, bea.id);
  const beaCookie = await signIn(stack.worker, db, `bea@${owner.domain}`);

  // 1. The customer writes support@: it lands in Unassigned, open.
  const customer = `luis-${randomUUID().slice(0, 8)}@client.test`;
  const subject = `Invoice ${randomUUID().slice(0, 6)} is wrong`;
  await deliver({ from: `Luis Ortega <${customer}>`, to: support, subject, text: "Billed twice." });
  const threadId = await waitFor(async () => {
    const view = await call(ana, "GET", `/conversations?mailboxId=${mailboxId}&view=unassigned`);
    return view.body.conversations?.find((c: { subject: string }) => c.subject === subject)?.id as
      | string
      | undefined;
  });
  expect(await conversation()).toMatchObject({ status: "open", assigneeMemberId: null });

  async function conversation() {
    const response = await call(ana, "GET", `/threads/${threadId}/conversation`);
    expect(response.status).toBe(200);
    return response.body as unknown as {
      status: string;
      assigneeMemberId: string | null;
      firstRespondedAt: string | null;
      events: { kind: string; data: Record<string, unknown> }[];
    };
  }
  const inView = async (view: string) =>
    (
      await call(ana, "GET", `/conversations?mailboxId=${mailboxId}&view=${view}`)
    ).body.conversations.some((c: { id: string }) => c.id === threadId);

  // 2. Ana claims it: it leaves Unassigned and is hers.
  expect((await call(ana, "POST", `/threads/${threadId}/claim`)).status).toBe(200);
  expect(await conversation()).toMatchObject({ assigneeMemberId: anaId });
  expect(await inView("unassigned")).toBe(false);
  expect(await inView("mine")).toBe(true);

  // 3. A note mentioning Bea notifies her, and only her; the customer never sees it.
  const note = await call(ana, "POST", `/threads/${threadId}/notes`, {
    body: "@Bea did we double charge Luis?",
    mentions: [bea.id],
  });
  expect(note).toMatchObject({ status: 201, body: { notified: [bea.id] } });
  const beaInbox = await waitFor(async () => {
    const page = await call(beaCookie, "GET", "/notifications?unread=true");
    return page.body.notifications?.length ? page.body : undefined;
  });
  expect(beaInbox.notifications).toEqual([expect.objectContaining({ kind: "mention", threadId })]);

  // 4. A canned reply, filled in for this customer, goes out with a file.
  const canned = await call(ana, "POST", "/canned-replies", {
    mailboxId,
    title: "Refund issued",
    bodyText: "Hi {{customer.first_name}}, the duplicate charge is refunded. {{agent.name}}",
  });
  expect(canned.status).toBe(201);
  const rendered = await call(ana, "POST", `/canned-replies/${canned.body.id}/render`, {
    threadId,
  });
  expect(rendered).toMatchObject({ status: 200, body: { missing: [] } });
  expect(rendered.body.text).toMatch(/^Hi Luis, the duplicate charge is refunded\./);

  const receipt = new TextEncoder().encode("refund receipt 2026-11-12\n");
  const uploaded = await fetch(
    new URL(`/api/uploads?mailboxId=${mailboxId}&filename=receipt.txt`, stack.worker.url),
    {
      method: "POST",
      headers: { cookie: ana, origin: WEB_ORIGIN, "content-type": "text/plain" },
      body: receipt,
    },
  );
  expect(uploaded.status).toBe(201);
  const upload = (await uploaded.json()) as { id: string };
  await mirrorUploadToMailServiceBucket(upload.id);

  const sent = await call(ana, "POST", `/threads/${threadId}/reply`, {
    text: rendered.body.text,
    attachments: [{ kind: "upload", uploadId: upload.id }],
  });
  expect(sent.status).toBe(202);
  const replyMessageId = sent.body.messageIdHeader as string;
  expect(replyMessageId).toBeTruthy();
  await waitFor(async () => {
    const action = await call(ana, "GET", `/actions/${sent.body.actionId}`);

    if (action.body.status === "failed") throw new Error(`send failed: ${action.body.error}`);
    return action.body.status === "done";
  });

  // The customer got it, file included, threaded on their mail.
  const delivered = await mailApp(customer, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const m of client.fetch("1:*", { envelope: true, source: true })) {
        if (m.envelope?.subject === `Re: ${subject}`) return m.source!.toString("utf8");
      }
      return undefined;
    } finally {
      lock.release();
    }
  });
  expect(delivered).toContain("receipt.txt");
  expect(delivered).toContain("Hi Luis, the duplicate charge is refunded.");

  // 5. Our reply makes it Pending and records the first response, once.
  await waitFor(async () => (await conversation()).status === "pending");
  const afterReply = await conversation();
  expect(afterReply.firstRespondedAt).not.toBeNull();
  expect(afterReply.events.filter((e) => e.kind === "first_response")).toHaveLength(1);
  expect(await inView("pending")).toBe(true);

  // The reply records who sent it: Ana's reads as hers, Bea sees it as the team's (grey, right).
  const replyFor = async (cookie: string) => {
    const thread = await call(cookie, "GET", `/threads/${threadId}`);
    const messages = (thread.body as unknown as { messages: ReplyView[] }).messages;
    return messages.find((m) => m.messageIdHeader === replyMessageId);
  };
  expect(await replyFor(ana)).toMatchObject({
    sentByMemberId: anaId,
    fromMe: true,
    fromTeam: true,
  });
  expect(await replyFor(beaCookie)).toMatchObject({
    sentByMemberId: anaId,
    fromMe: false,
    fromTeam: true,
  });

  // 6. The customer answers: it reopens.
  await deliver({
    from: `Luis Ortega <${customer}>`,
    to: support,
    subject: `Re: ${subject}`,
    text: "Thanks, still missing the second one though.",
    inReplyTo: replyMessageId,
  });
  await waitFor(async () => (await conversation()).status === "open");

  // 7. Resolve files the customer's mail out of INBOX on the server.
  const resolved = await call(ana, "POST", `/threads/${threadId}/resolve`);
  expect(resolved).toMatchObject({ status: 200, body: { changed: true } });
  await waitFor(async () => {
    const inbox = await folderSubjects(support, "INBOX");
    return !inbox.some((s) => s.includes(subject));
  });
  expect(await folderSubjects(support, "Archive")).toEqual(
    expect.arrayContaining([subject, `Re: ${subject}`]),
  );
  expect(await conversation()).toMatchObject({ status: "resolved" });

  // 8. An out-of-office in the same thread does not reopen it.
  await deliver({
    from: customer,
    to: support,
    subject: `Automatic reply: Re: ${subject}`,
    text: "I am out of the office until Monday.",
    inReplyTo: replyMessageId,
    headers: { "Auto-Submitted": "auto-replied" },
  });
  // Stored is not enough: wait until the Worker applied the status rule to it, in this thread.
  const autoReply = await waitFor(async () => {
    const [row] = await db
      .select({
        threadId: schema.messages.threadId,
        workflowAppliedAt: schema.messages.workflowAppliedAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.mailboxId, mailboxId),
          eq(schema.messages.subject, `Automatic reply: Re: ${subject}`),
        ),
      );
    return row?.workflowAppliedAt ? row : undefined;
  });
  expect(autoReply.threadId).toBe(threadId);
  expect(await conversation()).toMatchObject({ status: "resolved" });

  /** Puts the staged file where the mail service reads it (one R2 bucket in production). */
  async function mirrorUploadToMailServiceBucket(uploadId: string) {
    const [row] = await db
      .select({ r2Key: schema.uploads.r2Key, mimeType: schema.uploads.mimeType })
      .from(schema.uploads)
      .where(eq(schema.uploads.id, uploadId));
    const bytes = await fetch(new URL(`/api/uploads/${uploadId}`, stack.worker.url), {
      headers: { cookie: ana, origin: WEB_ORIGIN },
    });
    expect(bytes.status).toBe(200);
    await s3().put(row!.r2Key, new Uint8Array(await bytes.arrayBuffer()), row!.mimeType);
  }
});

test("a conversation deleted in another mail app leaves the helpdesk", async () => {
  const { db } = stack.database;
  const owner = await stack.workspaceWithDomain();
  const support = `support@${owner.domain}`;
  const created = await stack.api(owner.jar, "POST", "/onboarding/mailboxes", {
    domainId: owner.domainId,
    localPart: "support",
    login: {
      password: "app-password",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  });
  const mailboxId = created.body.mailboxId as string;
  await waitFor(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });
  const ana = owner.jar.header;
  const subject = `Win a cruise ${randomUUID().slice(0, 6)}`;
  await deliver({ from: "promo@outside.test", to: support, subject, text: "Click here." });
  const threadId = await waitFor(async () => {
    const view = await call(ana, "GET", `/conversations?mailboxId=${mailboxId}&view=open`);
    return view.body.conversations?.find((c: { subject: string }) => c.subject === subject)?.id as
      | string
      | undefined;
  });

  // Deleted for good in another app (flagged \Deleted and expunged, as Apple Mail erases).
  await mailApp(support, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ subject }, { uid: true })) || [];
      expect(uids).toHaveLength(1);
      await client.messageDelete(uids, { uid: true });
    } finally {
      lock.release();
    }
  });
  // The first full sync sees the copy gone; the next finds it nowhere and drops the thread.
  await stack.service.supervisor.syncAll();
  await stack.service.supervisor.syncAll();

  expect((await call(ana, "GET", `/threads/${threadId}/conversation`)).status).toBe(404);
  for (const view of ["open", "unassigned", "all"]) {
    const page = await call(ana, "GET", `/conversations?mailboxId=${mailboxId}&view=${view}`);
    expect([view, page.body.conversations.map((c: { id: string }) => c.id)]).toEqual([view, []]);
  }
});

test("a conversation moved to Trash in another mail app is resolved, and a reopen sticks", async () => {
  const { db } = stack.database;
  const owner = await stack.workspaceWithDomain();
  const support = `support@${owner.domain}`;
  const created = await stack.api(owner.jar, "POST", "/onboarding/mailboxes", {
    domainId: owner.domainId,
    localPart: "support",
    login: {
      password: "app-password",
      imap: { host: greenmail.host, port: greenmail.imapPort },
      smtp: { host: greenmail.host, port: greenmail.smtpPort },
    },
  });
  const mailboxId = created.body.mailboxId as string;
  await waitFor(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    return row?.status === "active";
  });
  const ana = owner.jar.header;
  const subject = `Win a cruise ${randomUUID().slice(0, 6)}`;
  await deliver({ from: "promo@outside.test", to: support, subject, text: "Click here." });
  const ids = async (view: string) =>
    (
      await call(ana, "GET", `/conversations?mailboxId=${mailboxId}&view=${view}`)
    ).body.conversations.map((c: { id: string }) => c.id);
  const threadId = await waitFor(async () => {
    const view = await call(ana, "GET", `/conversations?mailboxId=${mailboxId}&view=open`);
    return view.body.conversations?.find((c: { subject: string }) => c.subject === subject)?.id as
      | string
      | undefined;
  });
  const conversation = async () =>
    (await call(ana, "GET", `/threads/${threadId}/conversation`)).body as unknown as {
      status: string;
      events: { kind: string; actorMemberId: string | null; data: Record<string, unknown> }[];
    };

  // Apple Mail's delete: move to Trash (and expunge from INBOX).
  await mailApp(support, async (client) => {
    await client.mailboxCreate("Trash").catch(() => {});
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ subject }, { uid: true })) || [];
      expect(uids).toHaveLength(1);
      await client.messageMove(uids, "Trash", { uid: true });
    } finally {
      lock.release();
    }
  });
  await stack.service.supervisor.syncAll();
  await stack.service.supervisor.syncAll();

  // Resolved by Omni, with a line that says why; it leaves Open and Unassigned.
  await waitFor(async () => (await conversation()).status === "resolved");
  expect((await conversation()).events.filter((e) => e.kind === "status")).toEqual([
    expect.objectContaining({
      actorMemberId: null,
      data: expect.objectContaining({ to: "resolved", reason: "discarded_elsewhere" }),
    }),
  ]);
  for (const view of ["open", "unassigned"]) {
    expect([view, await ids(view)]).toEqual([view, expect.not.arrayContaining([threadId])]);
  }
  // Nothing moved on the server: the mail stays in Trash.
  expect(await folderSubjects(support, "Trash")).toContain(subject);

  // A teammate reopens it in Omni: later syncs leave it open (no resolve loop).
  expect((await call(ana, "POST", `/threads/${threadId}/reopen`)).status).toBe(200);
  await stack.service.supervisor.syncAll();
  await stack.service.supervisor.syncAll();
  expect((await conversation()).status).toBe("open");
  expect(await ids("open")).toContain(threadId);
});

/** A message as `GET /threads/:id` answers, the fields the sender check reads. */
interface ReplyView {
  messageIdHeader: string;
  sentByMemberId: string | null;
  fromMe: boolean;
  fromTeam: boolean;
}

function s3() {
  return createS3Store({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:7070",
    bucket: process.env.S3_BUCKET ?? "omni-mail-dev",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "omni-local",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "omni-local-secret",
    region: process.env.S3_REGION ?? "auto",
  });
}

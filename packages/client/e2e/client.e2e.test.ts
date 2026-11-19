import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  postMailEvents,
  seedMessage,
  startMailServiceEndpoint,
  sentMail,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
  type TestDb,
} from "../../../apps/worker/e2e/support.ts";
import {
  connectRealtime,
  createApi,
  createAuth,
  type RealtimeEvent,
  type RealtimeStatus,
} from "../src/index.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function cookieJar() {
  const cookies = new Map<string, string>();
  const header = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  return {
    header,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("origin", WEB_ORIGIN);
      if (cookies.size) request.headers.set("cookie", header());
      const response = await fetch(request);
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return response;
    }) as typeof fetch,
  };
}

async function signIn(db: TestDb, email: string) {
  const jar = cookieJar();
  const baseUrl = String(worker.url);
  const auth = createAuth({ baseUrl, fetch: jar.fetch });
  const requested = await auth.signIn.magicLink({ email });
  expect(requested.error).toBeNull();

  const link = (await sentMail(worker, email)).at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`no magic link sent to ${email}`);
  const token = new URL(link).searchParams.get("token") ?? "";
  const verified = await auth.magicLink.verify({ query: { token } });
  expect(verified.error).toBeNull();

  return { auth, jar, api: createApi({ baseUrl, fetch: jar.fetch }) };
}

const waiters = new Set<() => void>();
const heard = () => {
  for (const waiter of waiters) waiter();
};

async function until<T>(read: () => T | undefined) {
  const found = Promise.withResolvers<T>();
  const check = () => {
    const value = read();
    if (value !== undefined) found.resolve(value);
  };
  waiters.add(check);
  check();
  return found.promise.finally(() => waiters.delete(check));
}

test("a member signs in with the auth client and reads only their own mail over RPC", async () => {
  const { db } = database;
  const org = await createOrg(db, "acme");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@acme.test");
  const bea = await createMember(db, org.id, "bea@acme.test");
  const anaBox = await createMailbox(db, org.id, "ana@acme.test", "personal");
  const beaBox = await createMailbox(db, org.id, "bea@acme.test", "personal");
  await grant(db, org.id, anaBox.id, ana.id);
  await grant(db, org.id, beaBox.id, bea.id);
  const mine = await seedMessage(db, anaBox, {
    subject: "Quarterly numbers",
    fromAddress: "cfo@client.test",
    uid: 1,
  });
  await seedMessage(db, beaBox, { subject: "Not for Ana", fromAddress: "x@client.test", uid: 1 });

  const anonymous = createApi({ baseUrl: String(worker.url) });
  expect((await anonymous.me.$get()).status).toBe(401);

  const { auth, api } = await signIn(db, "ana@acme.test");

  const session = await auth.getSession();
  expect(session.data?.user.email).toBe("ana@acme.test");
  const orgs = await auth.organization.list();
  expect(orgs.data?.map((o) => o.id)).toEqual([org.id]);

  const me = await api.me.$get();
  expect(me.status).toBe(200);
  if (!me.ok) throw new Error("unreachable");
  expect(await me.json()).toMatchObject({ id: ana.id, orgId: org.id });

  const list = await api.threads.$get({ query: {} });
  if (!list.ok) throw new Error(`thread list failed: ${list.status}`);
  const page = await list.json();
  expect(page.threads.map((t) => t.id)).toEqual([mine.threadId]);
  expect(page.nextCursor).toBeNull();

  const detail = await api.threads[":id"].$get({ param: { id: mine.threadId } });
  if (!detail.ok) throw new Error(`thread read failed: ${detail.status}`);
  const thread = await detail.json();
  expect(thread.messages.map((m) => m.subject)).toEqual(["Quarterly numbers"]);
  expect(Number.isNaN(Date.parse(thread.lastMessageAt))).toBe(false);

  await auth.signOut();
  expect((await api.me.$get()).status).toBe(401);
});

test("realtime hands typed events to the app and reconnects after the server drops it", async () => {
  const { db } = database;
  const org = await createOrg(db, "live");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@live.test");
  const box = await createMailbox(db, org.id, "ana@live.test", "personal");
  await grant(db, org.id, box.id, ana.id);
  const first = await seedMessage(db, box, { subject: "One", fromAddress: "a@x.test", uid: 1 });
  const second = await seedMessage(db, box, { subject: "Two", fromAddress: "a@x.test", uid: 2 });

  const { jar } = await signIn(db, "ana@live.test");
  const events: RealtimeEvent[] = [];
  const statuses: [RealtimeStatus, boolean][] = [];
  let socket: WebSocket | undefined;
  const realtime = connectRealtime({
    baseUrl: String(worker.url),
    openSocket: (url) =>
      (socket = new WebSocket(url, {
        headers: { cookie: jar.header(), origin: WEB_ORIGIN },
      } as unknown as string[])),
    onEvent: (event) => {
      events.push(event);
      heard();
    },
    onStatus: (status, { reconnected }) => {
      statuses.push([status, reconnected]);
      heard();
    },
    minDelayMs: 50,
  });
  const opens = () => statuses.filter(([s]) => s === "open").length;

  try {
    await until(() => (opens() === 1 ? true : undefined));
    const post = (thread: { threadId: string; messageId: string }) =>
      postMailEvents(worker, {
        events: [
          {
            type: "message.created",
            folderRole: "inbox",
            orgId: org.id,
            mailboxId: box.id,
            threadId: thread.threadId,
            messageId: thread.messageId,
          },
        ],
      });

    expect((await post(first)).status).toBe(202);
    await until(() => events[1]);
    expect(events).toEqual([
      { type: "changed", mailboxId: box.id, threadIds: [first.threadId] },
      { type: "thread.changed", mailboxId: box.id, threadIds: [first.threadId] },
    ]);

    await worker.server
      .getWorker()
      .evictDurableObject("Realtime", { name: org.id, webSockets: "close" });
    await until(() => (opens() === 2 ? true : undefined));
    expect(statuses.filter(([s]) => s === "open")).toEqual([
      ["open", false],
      ["open", true],
    ]);

    expect((await post(second)).status).toBe(202);
    await until(() => events[3]);
    expect(events.slice(2)).toEqual([
      { type: "changed", mailboxId: box.id, threadIds: [second.threadId] },
      { type: "thread.changed", mailboxId: box.id, threadIds: [second.threadId] },
    ]);
  } finally {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const closed = new Promise((resolve) => socket?.addEventListener("close", resolve));
      realtime.close();
      await closed;
      const settled = statuses.length;
      vi.runOnlyPendingTimers();
      expect(statuses.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  }
  expect(statuses.at(-1)?.[0]).toBe("closed");
});

test("wake() reconnects now instead of waiting out the backoff", async () => {
  const { db } = database;
  const org = await createOrg(db, "wake");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  await createMember(db, org.id, "ana@wake.test");
  const { jar } = await signIn(db, "ana@wake.test");
  const statuses: RealtimeStatus[] = [];
  const realtime = connectRealtime({
    baseUrl: String(worker.url),
    openSocket: (url) =>
      new WebSocket(url, {
        headers: { cookie: jar.header(), origin: WEB_ORIGIN },
      } as unknown as string[]),
    onEvent: () => {},
    onStatus: (status) => {
      statuses.push(status);
      heard();
    },
    minDelayMs: 600_000,
    maxDelayMs: 600_000,
  });
  const opens = () => statuses.filter((s) => s === "open").length;

  try {
    await until(() => (opens() === 1 ? true : undefined));
    await worker.server
      .getWorker()
      .evictDurableObject("Realtime", { name: org.id, webSockets: "close" });
    await until(() => (statuses.at(-1) === "closed" ? true : undefined));

    realtime.wake();
    await until(() => (opens() === 2 ? true : undefined));
    expect(statuses.slice(-2)).toEqual(["connecting", "open"]);
  } finally {
    realtime.close();
  }
});

test("realtime hands the app a Drive change, so an open folder can refetch", async () => {
  const { db } = database;
  const org = await createOrg(db, "drive-live");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  await createMember(db, org.id, "ana@drive-live.test");
  const { jar, api } = await signIn(db, "ana@drive-live.test");
  const events: RealtimeEvent[] = [];
  let open = false;
  const realtime = connectRealtime({
    baseUrl: String(worker.url),
    orgId: org.id,
    openSocket: (url) =>
      new WebSocket(url, {
        headers: { cookie: jar.header(), origin: WEB_ORIGIN },
      } as unknown as string[]),
    onEvent: (event) => {
      events.push(event);
      heard();
    },
    onStatus: (status) => {
      open = status === "open";
      heard();
    },
  });
  try {
    await until(() => (open ? true : undefined));
    const made = await api.storage.folders.$post({ json: { name: "Plans", space: "personal" } });
    expect(made.status).toBe(201);
    expect(await until(() => events[0])).toEqual({ type: "storage.changed", space: "personal" });
  } finally {
    realtime.close();
  }
});

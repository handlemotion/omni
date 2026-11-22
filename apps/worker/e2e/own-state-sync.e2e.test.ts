import { afterAll, beforeAll, expect, test } from "vitest";
import {
  pushFrame,
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

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

let keys = 0;

function api(cookie: string, method: string, path: string, json?: unknown) {
  return fetch(new URL(`/api${path}`, worker.url), {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": `own-state-${keys++}`,
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });
}

async function connect(cookie: string) {
  const url = new URL("/api/realtime", worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: { type: string; threadIds?: string[] }[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    pushFrame(received, e.data);
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
    async next(count: number) {
      const enough = Promise.withResolvers<void>();
      const check = () => received.length >= count && enough.resolve();
      waiters.add(check);
      check();
      await enough.promise.finally(() => waiters.delete(check));
      return received.slice(0, count);
    },
  };
}

test("read, Done and Later reach every one of the member's apps at once, and no teammate's", async () => {
  const { db } = database;
  const org = await createOrg(db, "devices");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const box = await createMailbox(db, org.id, "hello@devices.test", "shared");
  const ana = await createMember(db, org.id, "ana@devices.test");
  const bea = await createMember(db, org.id, "bea@devices.test");
  await grant(db, org.id, box.id, ana.id);
  await grant(db, org.id, box.id, bea.id);
  const { threadId } = await seedMessage(db, box, {
    subject: "Invoice",
    fromAddress: "luis@client.test",
    uid: 1,
  });
  const anaCookie = await signIn(worker, db, "ana@devices.test");
  const beaCookie = await signIn(worker, db, "bea@devices.test");
  const desktop = await connect(anaCookie);
  const phone = await connect(anaCookie);
  const teammate = await connect(beaCookie);

  const changed = { type: "changed", mailboxId: box.id, threadIds: [threadId] };
  const steps = [
    ["PATCH", `/threads/${threadId}/state`, { read: true }],
    ["POST", `/threads/${threadId}/done`, { through: new Date().toISOString() }],
    ["DELETE", `/threads/${threadId}/done`],
    ["POST", `/threads/${threadId}/later`],
    ["DELETE", `/threads/${threadId}/later`],
  ] as const;
  for (const [method, path, body] of steps) {
    expect((await api(anaCookie, method, path, body)).status).toBe(200);
  }
  const heard = steps.map(() => changed);
  expect(await phone.next(steps.length)).toEqual(heard);
  expect(await desktop.next(steps.length)).toEqual(heard);

  const counts = await (await api(anaCookie, "GET", "/counts")).json();
  expect(counts).toMatchObject({ counts: [{ mailboxId: box.id, inbox: 1, unread: 0 }] });

  expect((await api(anaCookie, "POST", `/threads/${threadId}/archive`)).status).toBe(200);
  const [first] = await teammate.next(1);
  expect(first).toEqual(changed);

  for (const socket of [desktop, phone, teammate]) socket.socket.close();
});

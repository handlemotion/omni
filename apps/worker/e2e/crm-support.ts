import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import {
  pushFrame,
  CookieJar,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  WEB_ORIGIN,
} from "./support.ts";

export type CrmStack = Awaited<ReturnType<typeof startCrmStack>>;
export type Person = Awaited<ReturnType<CrmStack["member"]>>;

export async function startCrmStack(options: { vars?: Record<string, string> } = {}) {
  const database = await createTestDatabase();
  const mailService = await startMailServiceEndpoint();
  const worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: options.vars,
  });
  const { db } = database;

  async function api(jar: CookieJar, method: string, path: string, body?: unknown) {
    const response = await fetch(new URL(`/api/crm${path}`, worker.url), {
      method,
      headers: { cookie: jar.header, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
  }

  async function socket(jar: CookieJar) {
    const url = new URL("/api/realtime", worker.url);
    url.protocol = "ws:";
    const ws = new WebSocket(url, {
      headers: { cookie: jar.header, origin: WEB_ORIGIN },
    } as unknown as string[]);
    const received: Record<string, unknown>[] = [];
    const waiters = new Set<() => void>();
    ws.addEventListener("message", (e) => {
      pushFrame(received, e.data);
      for (const waiter of waiters) waiter();
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
    });
    return {
      received,
      close: () => ws.close(),
      async waitFor(match: (event: Record<string, unknown>) => boolean) {
        const arrived = Promise.withResolvers<Record<string, unknown>>();
        const check = () => {
          const found = received.find(match);
          if (found) arrived.resolve(found);
        };
        waiters.add(check);
        check();
        return arrived.promise.finally(() => waiters.delete(check));
      },
    };
  }

  return {
    database,
    db,
    worker,
    api,
    socket,
    company: (name: string) => createOrg(db, name),
    async member(orgId: string, role: "owner" | "admin" | "member" | "freelancer" = "member") {
      const email = `${role}-${randomUUID().slice(0, 8)}@crm.test`;
      const member = await createMember(db, orgId, email);
      await db.update(schema.members).set({ role }).where(eq(schema.members.id, member.id));
      const jar = new CookieJar();
      await signIn(worker, db, email, jar);
      return { ...member, email, jar };
    },
    async stop() {
      await worker.server.close();
      await mailService.close();
      await database.teardown();
    },
  };
}

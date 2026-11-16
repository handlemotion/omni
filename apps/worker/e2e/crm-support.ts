// What the CRM suites share: a real Worker over a throwaway database, people signed in over the
// real magic-link flow, JSON calls to `/api/crm`, and the realtime socket as the apps open it.
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import {
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

export async function startCrmStack() {
  const database = await createTestDatabase();
  const mailService = await startMailServiceEndpoint();
  const worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  const { db } = database;

  /** A JSON call to `/api/crm` as `jar`'s browser. The body is parsed when there is one. */
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

  /** The realtime socket as the web app opens it, collecting what arrives. */
  async function socket(jar: CookieJar) {
    const url = new URL("/api/realtime", worker.url);
    url.protocol = "ws:";
    // Node's WebSocket (undici) accepts headers: the session cookie and the web app's Origin.
    const ws = new WebSocket(url, {
      headers: { cookie: jar.header, origin: WEB_ORIGIN },
    } as unknown as string[]);
    const received: Record<string, unknown>[] = [];
    ws.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
    });
    return {
      received,
      close: () => ws.close(),
      /** Waits until an event matching `match` arrived. */
      async waitFor(match: (event: Record<string, unknown>) => boolean) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const found = received.find(match);
          if (found) return found;
          if (Date.now() > deadline) throw new Error("expected a realtime event");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
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
    /** A member of `orgId`, signed in with that company active. */
    async member(orgId: string, role: "owner" | "admin" | "member" = "member") {
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

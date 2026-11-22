import type { Client } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import type { StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

/** Live documents in e2e: a member's socket editing a file, and the S2 stream behind it. */
export const S2 = { url: "http://127.0.0.1:54380/v1", basin: "omni-docs-dev" };

export const WRITE = "openid mail:read drive:read drive:write";
export const bytes = (text: string) => new TextEncoder().encode(text);
export const base64 = (update: Uint8Array) => Buffer.from(update).toString("base64");

export type Event = Record<string, unknown>;

export async function editor(stack: StorageStack, jar: CookieJar, nodeId: string) {
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Event[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)) as Event);
    for (const waiter of waiters) waiter();
  });
  const waitFor = (match: (event: Event) => boolean) => {
    const found = Promise.withResolvers<Event>();
    const check = () => {
      const event = received.find(match);
      if (event) found.resolve(event);
    };
    waiters.add(check);
    check();
    return found.promise.finally(() => waiters.delete(check));
  };
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  socket.send(JSON.stringify({ type: "file.presence", nodeId, state: "editing" }));
  let ref = 0;
  const append = async (record: Event, matchSeqNum?: number) => {
    for (;;) {
      const sent = ++ref;
      socket.send(JSON.stringify({ type: "doc.append", nodeId, ref: sent, record, matchSeqNum }));
      const answer = await waitFor(
        (e) => (e.type === "doc.appended" || e.type === "doc.refused") && e.ref === sent,
      );
      if (answer.type === "doc.appended") return answer.seqNum as number;
      if (answer.reason !== "editing") throw new Error(`refused: ${String(answer.reason)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { socket, received, append, waitFor };
}

export async function trim(nodeId: string, seqNum: number) {
  const at = Buffer.alloc(8);
  at.writeBigUInt64BE(BigInt(seqNum));
  const response = await fetch(
    `${S2.url}/streams/${encodeURIComponent(`docs/${nodeId}`)}/records`,
    {
      method: "POST",
      headers: {
        "s2-basin": S2.basin,
        "s2-format": "base64",
        authorization: "Bearer local",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        records: [
          { headers: [["", Buffer.from("trim").toString("base64")]], body: at.toString("base64") },
        ],
      }),
    },
  );
  expect(response.status).toBe(200);
}

export async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text };
  return result.structuredContent as Record<string, unknown>;
}

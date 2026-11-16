// "Ana is editing" (ADR 0043 decision 3) through the real Worker and its realtime Durable
// Object: who hears it, that it survives hibernation, and that it clears when the app closes.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const bytes = (text: string) => new TextEncoder().encode(text);
const quiet = () => new Promise((resolve) => setTimeout(resolve, 500));

/** The web app's realtime socket for `jar`, collecting what arrives. */
async function connect(jar: CookieJar) {
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
    editing(nodeId: string, state: "editing" | "left") {
      socket.send(JSON.stringify({ type: "file.presence", nodeId, state }));
    },
    async next(count: number) {
      const deadline = Date.now() + 10_000;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count}, got ${received.length}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return received;
    },
  };
}

// Catches: an editing claim on a file the member cannot reach (it names the file to people who
// cannot see it, or tells its owner a stranger has it open), presence lost when the object
// hibernates (a second editor never learns the first is there), and a closed app that stays
// "editing" on everyone's screen.
test("editing presence reaches those who see the file, survives hibernation, and clears on close", async () => {
  const org = await stack.company(`presence-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "doc.md", bytes("# Doc"));
  const bos = await stack.upload(bo.jar, { space: "personal" }, "bo.md", bytes("mine"));
  const [anaHears, boHears] = [await connect(ana.jar), await connect(bo.jar)];
  const at = (memberId: string, state: string) => ({
    type: "file.presence",
    nodeId: doc.id,
    memberId,
    state,
  });

  anaHears.editing(doc.id, "editing");
  expect(await boHears.next(1)).toEqual([at(ana.id, "editing")]);
  // Kept on Ana's socket, not in memory: a hibernated object still knows she is there.
  await stack.worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: org.id, webSockets: "hibernate" });
  boHears.editing(doc.id, "editing");
  expect(await boHears.next(2)).toEqual([at(ana.id, "editing"), at(ana.id, "editing")]);
  expect(await anaHears.next(1)).toEqual([at(bo.id, "editing")]);

  // Bo's My files are his: Ana's claim to edit his file is dropped, and he hears nothing of it.
  anaHears.editing(bos.id, "editing");
  await quiet();
  expect(boHears.received).toHaveLength(2);

  anaHears.socket.close();
  expect((await boHears.next(3))[2]).toEqual(at(ana.id, "left"));
  expect(boHears.received).toHaveLength(3);
  boHears.socket.close();
});

// Catches: an `editing` whose access check finishes after the app already sent `left` (closed
// the editor), which would show the member editing a file they have closed until they reconnect.
test("a left sent while the editing check is still running wins", async () => {
  const org = await stack.company(`presence-race-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "doc.md", bytes("# Doc"));
  const [anaHears, boHears] = [await connect(ana.jar), await connect(bo.jar)];

  anaHears.editing(doc.id, "editing");
  anaHears.editing(doc.id, "left");
  await quiet();
  expect(boHears.received).toEqual([]);

  // A later heartbeat still lands as usual.
  anaHears.editing(doc.id, "editing");
  expect(await boHears.next(1)).toEqual([
    { type: "file.presence", nodeId: doc.id, memberId: ana.id, state: "editing" },
  ]);
  anaHears.socket.close();
  boHears.socket.close();
});

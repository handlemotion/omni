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

test("a private teamspace's files are its members' alone, over HTTP, and deleting it frees their bytes", async () => {
  const org = await stack.company(`ts-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const cy = await stack.member(org.id);

  const made = await stack.api(ana.jar, "POST", "/teamspaces", {
    name: "Legal",
    private: true,
    memberIds: [ben.id],
  });
  expect(made.status).toBe(201);
  const { id } = made.body.teamspace as { id: string };

  const file = await stack.upload(ana.jar, { teamspaceId: id }, "nda.txt", bytes("secret"));
  expect([file.space, file.teamspaceId, file.parentId]).toEqual(["teamspace", id, null]);
  const folder = await stack.api(ben.jar, "POST", "/folders", { name: "Drafts", teamspaceId: id });
  expect(folder.status).toBe(201);

  const listed = await stack.api(ben.jar, "GET", `/nodes?teamspace=${id}`);
  expect(listed.body.nodes.map((node: { name: string }) => node.name)).toEqual([
    "Drafts",
    "nda.txt",
  ]);
  expect((await stack.api(cy.jar, "GET", "/teamspaces")).body.teamspaces).toEqual([]);
  expect((await stack.api(cy.jar, "GET", `/nodes?teamspace=${id}`)).status).toBe(404);
  expect((await stack.download(cy.jar, file.id)).status).toBe(404);
  expect(
    (await stack.api(cy.jar, "PUT", `/teamspaces/${id}/members/${cy.id}`, { role: "member" }))
      .status,
  ).toBe(404);

  expect((await stack.api(ana.jar, "DELETE", `/teamspaces/${id}`)).status).toBe(409);
  for (const node of [file.id, folder.body.node.id]) {
    expect((await stack.api(ana.jar, "DELETE", `/nodes/${node}`)).status).toBe(200);
  }
  const bucket = await stack.bucket();
  expect(await bucket.head(`orgs/${org.id}/${file.id}`)).not.toBeNull();
  expect((await stack.api(ben.jar, "DELETE", `/teamspaces/${id}`)).status).toBe(403);
  expect((await stack.api(ana.jar, "DELETE", `/teamspaces/${id}`)).status).toBe(204);
  expect(await bucket.head(`orgs/${org.id}/${file.id}`)).toBeNull();
  expect(await stack.usedBytes(org.id)).toBe(0);
});

test("members are managed by owners, and a teamspace keeps one", async () => {
  const org = await stack.company(`ts-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const outsider = await stack.member((await stack.company(`ts-${randomUUID().slice(0, 8)}`)).id);

  const { id } = (await stack.api(ana.jar, "POST", "/teamspaces", { name: "Ops" })).body
    .teamspace as { id: string };
  const put = (jar: typeof ana.jar, memberId: string, role: string) =>
    stack.api(jar, "PUT", `/teamspaces/${id}/members/${memberId}`, { role });

  expect((await put(ben.jar, ben.id, "owner")).status).toBe(403);
  expect((await put(ana.jar, outsider.id, "member")).status).toBe(422);
  expect((await put(ana.jar, ana.id, "member")).body.code).toBe("LAST_OWNER");
  const added = await put(ana.jar, ben.id, "owner");
  expect(
    added.body.members
      .map((m: { memberId: string; role: string }) => [m.memberId, m.role])
      .toSorted(),
  ).toEqual(
    [
      [ana.id, "owner"],
      [ben.id, "owner"],
    ].toSorted(),
  );
  expect(
    (await stack.api(ben.jar, "PATCH", `/teamspaces/${id}`, { name: "Operations" })).body.teamspace
      .name,
  ).toBe("Operations");
  expect((await stack.api(ana.jar, "DELETE", `/teamspaces/${id}/members/${ana.id}`)).status).toBe(
    200,
  );
  expect((await stack.api(ben.jar, "DELETE", `/teamspaces/${id}/members/${ben.id}`)).status).toBe(
    409,
  );
});

async function listen(jar: CookieJar) {
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
  return { socket, received };
}

test("a change in a private teamspace is announced to who reaches it, never to the rest", async () => {
  const org = await stack.company(`ts-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const cy = await stack.member(org.id);
  const { id } = (await stack.api(ana.jar, "POST", "/teamspaces", { name: "Board", private: true }))
    .body.teamspace as { id: string };
  const [anaHears, cyHears] = [await listen(ana.jar), await listen(cy.jar)];

  await stack.upload(ana.jar, { teamspaceId: id }, "minutes.txt", bytes("quiet"));
  await expect
    .poll(() => anaHears.received.some((e) => e.type === "storage.changed" && e.teamspaceId === id))
    .toBe(true);
  await stack.upload(ana.jar, { space: "shared" }, "notice.txt", bytes("for all"));
  await expect
    .poll(() => cyHears.received.some((e) => e.type === "storage.changed" && e.space === "shared"))
    .toBe(true);
  expect(cyHears.received.filter((e) => e.teamspaceId === id)).toEqual([]);
  anaHears.socket.close();
  cyHears.socket.close();
});

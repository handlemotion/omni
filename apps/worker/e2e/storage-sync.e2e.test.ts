import { createHash, randomBytes, randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;

beforeAll(async () => {
  stack = await startStorageStack({ vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off" } });
}, 120_000);

afterAll(async () => {
  await stack?.worker.server.close();
  await stack?.database.teardown();
});

const at = (path: string) => new URL(path, stack.worker.url);
const NAVIGATION = { accept: "text/html", "sec-fetch-mode": "navigate" };

async function nextStep(response: Response) {
  if (response.status === 302) return new URL(response.headers.get("location")!);
  expect(response.status).toBe(200);
  return new URL(((await response.json()) as { url: string }).url);
}

async function connect(person: Person) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = at("/api/storage/sync/authorize");
  start.search = new URLSearchParams({ code_challenge: challenge, state: "s1" }).toString();
  const browser = (url: URL) =>
    fetch(url, { redirect: "manual", headers: { cookie: person.jar.header, ...NAVIGATION } });

  const authorize = await nextStep(await browser(start));
  expect(authorize.pathname).toBe("/api/auth/oauth2/authorize");
  const back = await nextStep(
    await browser(new URL(authorize.pathname + authorize.search, at("/"))),
  );
  expect(`${back.protocol}//${back.host}${back.pathname}`).toBe("omni://oauth/callback");
  expect(back.searchParams.get("state")).toBe("s1");

  const token = await fetch(at("/api/auth/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: "omni://oauth/callback",
      client_id: "omni-desktop",
      code_verifier: verifier,
      resource: authorize.searchParams.get("resource")!,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string; scope: string };
  expect(body.scope.split(" ")).toContain("storage:sync");
  return body.access_token;
}

async function sync(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(at(`/api/storage/sync${path}`), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "omni-error-format": "2",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function drain(token: string, orgId: string, space: string, cursor?: string) {
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  const changes: any[] = [];
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ space, limit: "2", ...(cursor ? { cursor } : {}) });
    const answer = await sync(token, "GET", `/${orgId}/changes?${query}`);
    expect(answer.status).toBe(200);
    changes.push(...answer.body.changes);
    cursor = answer.body.nextCursor as string;
    if (!answer.body.more) return { changes, cursor };
  }
  throw new Error("the feed never ended");
}

const bytes = (text: string) => new TextEncoder().encode(text);

test("a sync token reaches the person's own drives and nothing else", async () => {
  const acme = await stack.company(`acme-${randomUUID().slice(0, 6)}`);
  const other = await stack.company(`other-${randomUUID().slice(0, 6)}`);
  const ana = await stack.member(acme.id);
  const bo = await stack.member(acme.id);
  const outsider = await stack.member(other.id);
  const anas = await stack.upload(ana.jar, { space: "personal" }, "ana.txt", bytes("ana"));
  const shared = await stack.upload(ana.jar, { space: "shared" }, "team.txt", bytes("team"));
  const bos = await stack.upload(bo.jar, { space: "personal" }, "bo.txt", bytes("bo"));
  const theirs = await stack.upload(outsider.jar, { space: "shared" }, "x.txt", bytes("x"));
  const picked = await fetch(at("/api/oauth/workspace"), {
    method: "POST",
    headers: { cookie: ana.jar.header, "content-type": "application/json" },
    body: JSON.stringify({ workspace: acme.id }),
  });
  expect(picked.status).toBe(200);

  const token = await connect(ana);
  const drives = await sync(token, "GET", "/drives");
  expect(drives.status).toBe(200);
  expect(drives.body.workspaces).toHaveLength(2);
  expect(drives.body.workspaces).toContainEqual({
    orgId: acme.id,
    name: acme.name,
    drives: [
      { space: "personal", revision: anas.revision },
      { space: "shared", revision: shared.revision },
    ],
  });
  const own = drives.body.workspaces.find((w: { orgId: string }) => w.orgId !== acme.id);
  expect(own.drives).toEqual([{ space: "personal", revision: 0 }]);
  expect(own.orgId).not.toBe(other.id);

  const mine = await drain(token, acme.id, "personal");
  expect(mine.changes.map((change) => change.node.name)).toEqual(["ana.txt"]);
  const team = await drain(token, acme.id, "shared");
  expect(team.changes.map((change) => change.node.name)).toEqual(["team.txt"]);

  expect((await sync(token, "GET", `/${acme.id}/nodes/${bos.id}`)).status).toBe(404);
  expect((await sync(token, "GET", `/${acme.id}/files/${bos.id}/content`)).status).toBe(404);
  const rename = await sync(token, "PATCH", `/${acme.id}/nodes/${bos.id}`, { name: "mine.txt" });
  expect(rename.status).toBe(404);
  const elsewhere = [
    `/${other.id}/changes?space=shared`,
    `/${other.id}/nodes/${theirs.id}`,
    `/${other.id}/files/${theirs.id}/content`,
    `/${acme.id}/nodes/${theirs.id}`,
  ];
  const answers = await Promise.all(elsewhere.map((path) => sync(token, "GET", path)));
  expect(answers.map((answer) => answer.status)).toEqual(elsewhere.map(() => 404));

  const download = await fetch(at(`/api/storage/sync/${acme.id}/files/${anas.id}/content`), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await download.text()).toBe("ana");

  const mcp = await fetch(at("/mcp"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(mcp.status).toBe(401);
  expect((await sync("not-a-token", "GET", "/drives")).status).toBe(401);
  const cookie = await fetch(at("/api/storage/sync/drives"), {
    headers: { cookie: ana.jar.header },
  });
  expect(cookie.status).toBe(401);
});

test("a change with a stale ifRevision answers 409 and changes nothing", async () => {
  const acme = await stack.company(`guard-${randomUUID().slice(0, 6)}`);
  const ana = await stack.member(acme.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "draft.txt", bytes("v1"));
  const token = await connect(ana);
  const first = await sync(token, "PATCH", `/${acme.id}/nodes/${file.id}`, { name: "a.txt" });
  expect(first.status).toBe(200);

  const stale = `?ifRevision=${file.revision}`;
  const rename = await sync(token, "PATCH", `/${acme.id}/nodes/${file.id}${stale}`, {
    name: "b.txt",
  });
  expect(rename.status).toBe(409);
  expect(rename.body.error.code).toBe("version_conflict");
  const trash = await sync(token, "DELETE", `/${acme.id}/nodes/${file.id}${stale}`);
  expect(trash.status).toBe(409);
  const now = await sync(token, "GET", `/${acme.id}/nodes/${file.id}`);
  expect(now.body.node).toMatchObject({ name: "a.txt", trashedAt: null });

  const fresh = `?ifRevision=${now.body.node.revision}`;
  const done = await sync(token, "DELETE", `/${acme.id}/nodes/${file.id}${fresh}`);
  expect(done.status).toBe(200);
  expect((await sync(token, "GET", `/${acme.id}/nodes/${file.id}`)).status).toBe(404);
  const feed = await drain(token, acme.id, "personal");
  expect(feed.changes).toMatchObject([{ id: file.id, inTrash: true }]);
});

test("a cursor behind swept tombstones answers 410; starting over works", async () => {
  const acme = await stack.company(`sweep-${randomUUID().slice(0, 6)}`);
  const ana = await stack.member(acme.id);
  const token = await connect(ana);
  const opened = await sync(token, "POST", `/${acme.id}/uploads`, {
    name: "old.txt",
    size: 0,
    space: "personal",
    sha256: createHash("sha256").update("").digest("hex"),
  });
  expect(opened.status).toBe(201);
  const done = await sync(token, "POST", `/${acme.id}/uploads/${opened.body.upload.id}/complete`);
  expect(done.status).toBe(200);
  const fileId = done.body.node.id as string;
  const behind = await drain(token, acme.id, "personal");
  expect(behind.changes).toMatchObject([
    {
      id: fileId,
      inTrash: false,
      node: { contentSha256: createHash("sha256").update("").digest("hex") },
    },
  ]);

  expect((await sync(token, "DELETE", `/${acme.id}/nodes/${fileId}`)).status).toBe(200);
  expect((await sync(token, "DELETE", `/${acme.id}/nodes/${fileId}?forever=1`)).status).toBe(204);
  const past = await drain(token, acme.id, "personal", behind.cursor);
  expect(past.changes).toEqual([
    { id: fileId, revision: expect.any(Number), node: null, inTrash: false },
  ]);

  await stack.db
    .update(schema.storageTombstones)
    .set({ createdAt: new Date(Date.now() - 91 * 86_400_000) })
    .where(eq(schema.storageTombstones.orgId, acme.id));
  expect(await stack.cron("47 3 * * *")).toBe("ok");

  const expired = await sync(
    token,
    "GET",
    `/${acme.id}/changes?space=personal&cursor=${behind.cursor}`,
  );
  expect(expired.status).toBe(410);
  expect(expired.body.error.code).toBe("cursor_expired");
  const again = await sync(
    token,
    "GET",
    `/${acme.id}/changes?space=personal&cursor=${past.cursor}`,
  );
  expect(again.status).toBe(200);
  expect((await sync(token, "GET", `/${acme.id}/changes?space=personal`)).status).toBe(200);
});

async function listen(token: string, orgId: string) {
  const url = at(`/api/storage/sync/${orgId}/realtime`);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  const received: { type: string; space: string; parentIds?: (string | null)[] }[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)));
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
    async until(space: string) {
      const heard = Promise.withResolvers<void>();
      const check = () => received.some((event) => event.space === space) && heard.resolve();
      waiters.add(check);
      check();
      await heard.promise.finally(() => waiters.delete(check));
      return received.splice(0);
    },
  };
}

test("a change pings the drives it touched, on the sockets of those who sync them", async () => {
  const acme = await stack.company(`live-${randomUUID().slice(0, 6)}`);
  const ana = await stack.member(acme.id);
  const bo = await stack.member(acme.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "plan.txt", bytes("plan"));
  const bos = await stack.upload(bo.jar, { space: "personal" }, "bo.txt", bytes("bo"));
  const [anaToken, boToken] = [await connect(ana), await connect(bo)];
  const [anaHears, boHears] = await Promise.all([
    listen(anaToken, acme.id),
    listen(boToken, acme.id),
  ]);

  const moved = await sync(anaToken, "PATCH", `/${acme.id}/nodes/${file.id}`, {
    space: "shared",
  });
  expect(moved.status).toBe(200);
  const forAna = await anaHears.until("personal");
  if (!forAna.some((event) => event.space === "shared"))
    forAna.push(...(await anaHears.until("shared")));
  expect(new Set(forAna.map((event) => event.space))).toEqual(new Set(["personal", "shared"]));
  expect(forAna.every((event) => event.type === "storage.changed")).toBe(true);
  expect(await boHears.until("shared")).toEqual([
    { type: "storage.changed", space: "shared", parentIds: [null] },
  ]);

  expect(
    (await sync(boToken, "PATCH", `/${acme.id}/nodes/${bos.id}`, { name: "b.txt" })).status,
  ).toBe(200);
  expect(await boHears.until("personal")).toEqual([
    { type: "storage.changed", space: "personal", parentIds: [null] },
  ]);
  expect(anaHears.received).toEqual([]);

  anaHears.socket.close();
  boHears.socket.close();
});

test("a move names the folders it left and entered, so apps refetch only those", async () => {
  const acme = await stack.company(`folders-${randomUUID().slice(0, 6)}`);
  const ana = await stack.member(acme.id);
  const bo = await stack.member(acme.id);
  const token = await connect(ana);
  const folder = async (name: string) =>
    (await stack.api(ana.jar, "POST", "/folders", { name, space: "personal" })).body.node
      .id as string;
  const [fromId, intoId] = [await folder("From"), await folder("Into")];
  const file = await stack.upload(ana.jar, { parentId: fromId }, "plan.txt", bytes("plan"));
  const [anaHears, boHears] = await Promise.all([
    listen(token, acme.id),
    listen(await connect(bo), acme.id),
  ]);

  const moved = await sync(token, "PATCH", `/${acme.id}/nodes/${file.id}`, { parentId: intoId });
  expect(moved.status).toBe(200);
  const [event, ...rest] = await anaHears.until("personal");
  expect(rest).toEqual([]);
  expect(new Set(event?.parentIds)).toEqual(new Set([fromId, intoId]));
  expect(boHears.received).toEqual([]);

  anaHears.socket.close();
  boHears.socket.close();
});

test("a new version and a restore reach the provider as new bytes", async () => {
  const acme = await stack.company(`versions-${randomUUID().slice(0, 6)}`);
  const ana = await stack.member(acme.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "plan.md", bytes("first"));
  const token = await connect(ana);
  const { cursor } = await drain(token, acme.id, "personal");
  const hears = await listen(token, acme.id);

  const body = bytes("second");
  const opened = await stack.api(ana.jar, "POST", `/files/${file.id}/versions`, {
    size: body.length,
  });
  expect(opened.status).toBe(201);
  const uploadId = opened.body.upload.id as string;
  const sent = await stack.putPart(ana.jar, uploadId, 1, body);
  await sent.body?.cancel();
  expect((await stack.api(ana.jar, "POST", `/uploads/${uploadId}/complete`)).status).toBe(200);
  expect(await hears.until("personal")).toEqual([
    { type: "storage.changed", space: "personal", parentIds: [null] },
  ]);
  const saved = await drain(token, acme.id, "personal", cursor);
  expect(saved.changes.map((change) => [change.id, change.node.contentVersion])).toEqual([
    [file.id, 2],
  ]);

  const listed = await stack.api(ana.jar, "GET", `/files/${file.id}/versions`);
  const old = listed.body.versions[0].id as string;
  const restored = await stack.api(ana.jar, "POST", `/files/${file.id}/versions/${old}/restore`);
  expect(restored.status).toBe(200);
  expect(await hears.until("personal")).toEqual([
    { type: "storage.changed", space: "personal", parentIds: [null] },
  ]);
  const back = await drain(token, acme.id, "personal", saved.cursor);
  expect(back.changes.map((change) => [change.id, change.node.size])).toEqual([[file.id, 5]]);
  expect(back.changes[0].node.contentVersion).toBe(3);
  expect(back.changes[0].node.revision).toBeGreaterThan(saved.changes[0].node.revision);

  hears.socket.close();
});

// Comments on a file and the Commenter role (ADR 0043 decisions 4 and 5) over the real Worker
// and Postgres: who reads and writes them through which door, and how threads hold together.
import { randomUUID } from "node:crypto";
import type {
  StorageComment,
  StorageCommentsResponse,
  StorageNode,
  StorageUpload,
} from "@omni/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { CookieJar, signIn } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const bytes = (text: string) => new TextEncoder().encode(text);

async function grant(owner: CookieJar, nodeId: string, role: "viewer" | "commenter" | "editor") {
  const email = `${role}-${randomUUID().slice(0, 8)}@outside.test`;
  const shared = await stack.api(
    owner,
    "PUT",
    `/nodes/${nodeId}/sharing/people/${encodeURIComponent(email)}`,
    { role },
  );
  expect(shared.status).toBe(200);
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  return { email, jar, base: `/shared/${shared.body.sharing.shareId as string}` };
}

const list = async (jar: CookieJar, nodeId: string, base = "") => {
  const answer = await stack.api(jar, "GET", `${base}/files/${nodeId}/comments`);
  expect(answer.status).toBe(200);
  return answer.body as StorageCommentsResponse;
};

// Catches: the comment routes skipping the door (a Viewer or an anonymous link reading what
// people said, or anyone writing through a link alone), a Commenter treated as an Editor (the
// role sits between the two), and one person editing or deleting another's comment.
test("a Commenter reads and writes comments and nothing more; a Viewer and a link alone reach none", async () => {
  const org = await stack.company(`comments-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "personal" }, "deck.pdf", bytes("%PDF"));
  const opened = await stack.api(ana.jar, "POST", `/files/${file.id}/comments`, {
    body: "Page 2 needs the new numbers",
    anchor: { kind: "pdf", page: 2, x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
  });
  expect(opened.status).toBe(201);
  const root = opened.body.comment as StorageComment;
  expect(root).toMatchObject({ parentId: null, contentVersion: 1, mine: true });

  const commenter = await grant(ana.jar, file.id, "commenter");
  const viewer = await grant(ana.jar, file.id, "viewer");
  const shared = await stack.api(commenter.jar, "GET", "/shared-with-me");
  expect(shared.body.items[0]).toMatchObject({ role: "commenter", node: { id: file.id } });
  const item = await stack.api(commenter.jar, "GET", commenter.base);
  expect(item.body.item.role).toBe("commenter");

  const theirs = await list(commenter.jar, file.id, commenter.base);
  expect(theirs.comments).toEqual([{ ...root, mine: false, authorName: ana.email }]);
  const reply = await stack.api(
    commenter.jar,
    "POST",
    `${commenter.base}/files/${file.id}/comments`,
    {
      body: "On it",
      parentId: root.id,
    },
  );
  expect(reply.status).toBe(201);
  const answer = reply.body.comment as StorageComment;
  expect(answer).toMatchObject({ parentId: root.id, anchor: null, mine: true });
  const at = (id: string) => `/files/${file.id}/comments/${id}`;
  expect(
    (await stack.api(commenter.jar, "PATCH", `${commenter.base}${at(answer.id)}`, { body: "Done" }))
      .body.comment,
  ).toMatchObject({ body: "Done", editedAt: expect.any(String) });

  // A Commenter is not an Editor: no new version, no rename.
  const refused = [
    await stack.api(commenter.jar, "PATCH", `${commenter.base}${at(root.id)}`, {
      body: "mine now",
    }),
    await stack.api(commenter.jar, "DELETE", `${commenter.base}${at(root.id)}`),
    await stack.api(commenter.jar, "POST", `${commenter.base}/files/${file.id}/versions`, {
      size: 4,
    }),
    await stack.api(commenter.jar, "PATCH", `${commenter.base}/nodes/${file.id}`, {
      name: "renamed.pdf",
    }),
    await stack.api(viewer.jar, "GET", `${viewer.base}/files/${file.id}/comments`),
    await stack.api(viewer.jar, "POST", `${viewer.base}/files/${file.id}/comments`, { body: "hi" }),
  ].map((response) => response.status);
  expect(refused).toEqual([403, 403, 403, 403, 403, 403]);

  await stack.api(ana.jar, "PUT", `/nodes/${file.id}/sharing/link`, { linkAccess: "anyone" });
  const anonymous = new CookieJar();
  const base = viewer.base;
  expect((await stack.api(anonymous, "GET", `${base}/files/${file.id}/comments`)).status).toBe(403);
  expect(
    (await stack.api(anonymous, "POST", `${base}/files/${file.id}/comments`, { body: "hi" }))
      .status,
  ).toBe(403);

  // The owner sees the reply as the Commenter's, and may not change it either.
  const mine = await list(ana.jar, file.id);
  expect(mine.comments.map((comment) => [comment.body, comment.authorName, comment.mine])).toEqual([
    ["Page 2 needs the new numbers", ana.email, true],
    ["Done", commenter.email, false],
  ]);
  expect((await stack.api(ana.jar, "DELETE", at(answer.id))).status).toBe(403);

  // Removing the grant takes the comments away; the link open to anyone still shows the file.
  await stack.api(
    ana.jar,
    "DELETE",
    `/nodes/${file.id}/sharing/people/${encodeURIComponent(commenter.email)}`,
  );
  expect(
    (await stack.api(commenter.jar, "GET", `${commenter.base}/files/${file.id}/comments`)).status,
  ).toBe(403);
});

// Catches: a reply to a reply starting a nested thread the UI cannot show, a reply that leaves a
// resolved thread closed, a comment that bumps the file's revision (every sync client would
// download it again), a thread that loses the content version it was made on once the file
// changes, and a deleted root leaving orphan replies.
test("threads stay one level deep, follow resolve and reply, and keep the content version they were made on", async () => {
  const org = await stack.company(`threads-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const file = await stack.upload(ana.jar, { space: "shared" }, "notes.md", bytes("one\ntwo"));
  const post = async (jar: CookieJar, body: object) => {
    const answer = await stack.api(jar, "POST", `/files/${file.id}/comments`, body);
    expect(answer.status).toBe(201);
    return answer.body.comment as StorageComment;
  };
  const before = (await stack.api(ana.jar, "GET", `/nodes?space=shared`)).body
    .nodes[0] as StorageNode;

  const root = await post(ana.jar, {
    body: "Line 2?",
    anchor: { kind: "lines", start: 2, end: 2 },
  });
  const first = await post(ben.jar, { body: "Yes", parentId: root.id });
  const second = await post(ana.jar, { body: "Thanks", parentId: first.id });
  expect(second.parentId).toBe(root.id);
  const after = (await stack.api(ana.jar, "GET", `/nodes?space=shared`)).body
    .nodes[0] as StorageNode;
  expect(after.revision).toBe(before.revision);

  const at = (id: string) => `/files/${file.id}/comments/${id}`;
  const resolved = await stack.api(ben.jar, "PATCH", at(first.id), { resolved: true });
  expect(resolved.body.comment).toMatchObject({
    id: root.id,
    resolvedAt: expect.any(String),
    resolvedByName: ben.email,
  });
  await post(ana.jar, { body: "One more thing", parentId: root.id });
  expect((await list(ana.jar, file.id)).comments[0]).toMatchObject({
    resolvedAt: null,
    resolvedByName: null,
  });

  // Saving new content moves the file on; the thread still names the content it was made on.
  const body = bytes("one\ntwo\nthree");
  const opened = await stack.api(ana.jar, "POST", `/files/${file.id}/versions`, {
    size: body.length,
  });
  const upload = opened.body.upload as StorageUpload;
  await (await stack.putPart(ana.jar, upload.id, 1, body)).body?.cancel();
  expect((await stack.api(ana.jar, "POST", `/uploads/${upload.id}/complete`)).status).toBe(200);
  const now = await list(ben.jar, file.id);
  expect([now.contentVersion, now.comments[0]!.contentVersion]).toEqual([2, 1]);
  const later = await post(ben.jar, { body: "Whole file looks good" });
  expect(later).toMatchObject({ contentVersion: 2, anchor: { kind: "file" } });
  // Ben read version 1 before Ana saved: his anchor stays on the lines he saw.
  const stale = await post(ben.jar, {
    body: "Line 1 typo",
    anchor: { kind: "lines", start: 1, end: 1 },
    contentVersion: 1,
  });
  expect(stale.contentVersion).toBe(1);
  const ahead = await stack.api(ben.jar, "POST", `/files/${file.id}/comments`, {
    body: "From the future",
    contentVersion: 3,
  });
  expect([ahead.status, ahead.body.code]).toEqual([409, "VERSION_CONFLICT"]);

  // Bad anchors and a reply carrying one never reach the database.
  const invalid = [
    { body: "x", anchor: { kind: "lines", start: 3, end: 1 } },
    { body: "x", anchor: { kind: "pdf", page: 1, x: 0.8, y: 0, width: 0.5, height: 0.1 } },
    { body: "x", parentId: root.id, anchor: { kind: "file" } },
    { body: "   " },
  ];
  for (const bad of invalid) {
    expect((await stack.api(ana.jar, "POST", `/files/${file.id}/comments`, bad)).status).toBe(400);
  }

  expect((await stack.api(ana.jar, "DELETE", at(root.id))).status).toBe(204);
  expect((await list(ana.jar, file.id)).comments.map((comment) => comment.body)).toEqual([
    "Whole file looks good",
    "Line 1 typo",
  ]);
});

// Catches: a comment that tells nobody (or tells its own author), a reply that skips the people
// already in the thread, a notification that cannot find its file again, and someone from
// outside the workspace getting a notification that would open a Storage page they cannot see.
test("a comment notifies the file's owner and the thread's writers, never its author or an outsider", async () => {
  const org = await stack.company(`notify-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const cal = await stack.member(org.id);
  const notes = async (jar: CookieJar) => {
    const answer = await fetch(new URL("/api/notifications", stack.worker.url), {
      headers: { cookie: jar.header },
    });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      notifications: {
        kind: string;
        actorMemberId: string | null;
        data: Record<string, unknown>;
      }[];
    };
    return body.notifications.filter((n) => n.kind === "comment");
  };
  const post = async (jar: CookieJar, body: object, base = "") => {
    const answer = await stack.api(jar, "POST", `${base}/files/${file.id}/comments`, body);
    expect(answer.status).toBe(201);
    return answer.body.comment as StorageComment;
  };

  // Shared drive: Ana uploaded it, so she hears about Ben's comment; Ben does not hear his own.
  const file = await stack.upload(ana.jar, { space: "shared" }, "plan.md", bytes("plan"));
  const root = await post(ben.jar, { body: "Can we   move\nthis to Tuesday?" });
  expect(await notes(ana.jar)).toEqual([
    expect.objectContaining({
      actorMemberId: ben.id,
      data: {
        nodeId: file.id,
        nodeName: "plan.md",
        space: "shared",
        folderId: null,
        commentId: root.id,
        excerpt: "Can we move this to Tuesday?",
      },
    }),
  ]);
  expect(await notes(ben.jar)).toEqual([]);

  // Cal replies: Ana (owner) and Ben (wrote in the thread) hear, Cal does not.
  await post(cal.jar, { body: "Tuesday works", parentId: root.id });
  expect([(await notes(ana.jar)).length, (await notes(ben.jar)).length]).toEqual([2, 1]);
  expect(await notes(cal.jar)).toEqual([]);

  // An outside Commenter writes in the thread: they never get one, the workspace still does.
  const outsider = await grant(ana.jar, file.id, "commenter");
  await post(outsider.jar, { body: "From outside", parentId: root.id }, outsider.base);
  expect((await notes(cal.jar)).length).toBe(1);
  await post(ana.jar, { body: "Thanks all", parentId: root.id });
  expect(await notes(outsider.jar)).toEqual([]);

  // Moved since: opening the notification asks where the file is now, and gets its new folder.
  const folder = await stack.api(ana.jar, "POST", "/folders", { name: "Team", space: "shared" });
  expect(folder.status).toBe(201);
  const folderId = folder.body.node.id as string;
  expect(
    (await stack.api(ana.jar, "PATCH", `/nodes/${file.id}`, { parentId: folderId })).status,
  ).toBe(200);
  const now = await stack.api(cal.jar, "GET", `/nodes/${file.id}`);
  expect([now.status, now.body.node?.parentId, now.body.node?.space]).toEqual([
    200,
    folderId,
    "shared",
  ]);
  // Someone the workspace never let in learns nothing about where it is.
  expect((await stack.api(outsider.jar, "GET", `/nodes/${file.id}`)).status).toBe(404);
});

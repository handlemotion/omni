import type { Client } from "@modelcontextprotocol/client";
import type { StorageNode } from "@omni/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_SEARCH: "off",
      RATE_LIMIT_ACTIONS: "30/60",
    },
  });
}, 120_000);
afterAll(() => stack?.stop());

const WRITE = "openid mail:read drive:read drive:write";

// oxlint-disable-next-line typescript/no-explicit-any -- test reads of tool answers
type Answer = any;

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  const answer: Answer = result.isError
    ? { error: (result.content as { text: string }[])[0]!.text }
    : result.structuredContent;
  return answer;
}

const names = (nodes: StorageNode[]) => nodes.map((node) => node.name).sort();

test("an agent builds a folder tree, files into it, and trashes and restores, only where its person may", async () => {
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const carl = await stack.member(acme.id);
  const space = await stack.api(ana.jar, "POST", "/teamspaces", { name: "Ana", private: true });
  const teamspaceId = (space.body.teamspace as { id: string }).id;
  const notes = await stack.upload(
    ana.jar,
    { teamspaceId },
    "notes.txt",
    new TextEncoder().encode("hi"),
  );
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });

  const built = await call(agent, "drive_organize", {
    changes: [
      { action: "create_folder", name: "Clients", teamspace_id: teamspaceId, ref: "clients" },
      { action: "create_folder", name: "Acme", folder_id: "clients", ref: "acme" },
      { action: "move", id: notes.id, folder_id: "acme" },
      { action: "rename", id: notes.id, name: "kickoff.txt" },
      { action: "move", id: "clients", folder_id: "acme" },
    ],
  });
  expect(built.results.map((r: Answer) => r.ok)).toEqual([true, true, true, true, false]);
  expect(built.results[4].error).toContain("cannot move into itself");
  const acmeFolder = built.results[1].item;
  expect(acmeFolder).toMatchObject({ title: "Acme", kind: "folder", location: "Shared / Clients" });
  expect(built.results[3].item).toMatchObject({
    id: notes.id,
    title: "kickoff.txt",
    location: "Shared / Clients / Acme",
  });
  const inside = await stack.api(ana.jar, "GET", `/nodes?parent=${acmeFolder.id}`);
  expect(names(inside.body.nodes)).toEqual(["kickoff.txt"]);

  const carlAgent = await connectAgent(stack.worker.url, carl.jar, { scope: WRITE });
  const refused = await call(carlAgent, "drive_organize", {
    changes: [
      { action: "trash", id: notes.id },
      { action: "create_folder", name: "Mine", folder_id: acmeFolder.id },
    ],
  });
  expect(refused.results.map((r: Answer) => r.ok)).toEqual([false, false]);
  expect((await stack.download(ana.jar, notes.id)).status).toBe(200);

  const trashed = await call(agent, "drive_organize", {
    changes: [{ action: "trash", id: built.results[0].item.id }],
  });
  expect(trashed.results[0]).toMatchObject({ ok: true, id: built.results[0].item.id });
  const read = await call(agent, "drive_fetch", { id: notes.id });
  expect(read.error).toBeDefined();
  const trash = await stack.api(ana.jar, "GET", "/trash");
  expect(names(trash.body.nodes)).toEqual(["Clients"]);

  expect(
    (
      await call(carlAgent, "drive_organize", {
        changes: [{ action: "restore", id: built.results[0].item.id }],
      })
    ).results[0].ok,
  ).toBe(false);
  const restored = await call(agent, "drive_organize", {
    changes: [{ action: "restore", id: built.results[0].item.id }],
  });
  expect(restored.results[0]).toMatchObject({ ok: true, item: { title: "Clients" } });
  const undone = await call(agent, "drive_organize", {
    changes: [
      { action: "create_folder", name: "Scratch", teamspace_id: teamspaceId, ref: "scratch" },
      { action: "trash", id: "scratch" },
      { action: "restore", id: "scratch" },
    ],
  });
  expect(undone.results.map((r: Answer) => r.ok)).toEqual([true, true, true]);
  expect(undone.results[2].item).toMatchObject({ title: "Scratch" });

  expect(await call(agent, "drive_fetch", { id: notes.id })).toMatchObject({
    title: "kickoff.txt",
    metadata: { location: "Shared / Clients / Acme" },
  });
});

test("an agent comments on a passage, its person's teammate sees it, and the agent resolves it", async () => {
  const acme = await stack.company("acme-comments");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const space = await stack.api(bea.jar, "POST", "/teamspaces", { name: "Team" });
  const teamspaceId = (space.body.teamspace as { id: string }).id;
  await stack.api(ana.jar, "POST", `/teamspaces/${teamspaceId}/join`);
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const made = await call(agent, "drive_create_doc", {
    name: "Brief",
    teamspace_id: teamspaceId,
    markdown: "# Brief\n\nShip the **beta** on Friday.\n\nBudget is 10k.",
  });
  const id = made.doc.id;

  const missed = await call(agent, "drive_comment", {
    id,
    add: [{ text: "Which Friday?", quote: "Monday" }],
  });
  expect(missed.error).toContain("exactly once");
  const markdownQuote = await call(agent, "drive_comment", {
    id,
    add: [{ text: "Bold?", quote: "the **beta**" }],
  });
  expect(markdownQuote.error).toContain("exactly once");

  const added = await call(agent, "drive_comment", {
    id,
    add: [{ text: "Which Friday?", quote: "the beta on Friday" }, { text: "Looks good overall." }],
  });
  expect(added.added).toHaveLength(2);
  expect(added.threads).toMatchObject([
    { text: "Which Friday?", on: '"the beta on Friday"' },
    { text: "Looks good overall." },
  ]);
  expect(added.threads[1]).not.toHaveProperty("on");

  const seen = await stack.api(bea.jar, "GET", `/files/${id}/comments`);
  expect(seen.status).toBe(200);
  const root = seen.body.comments.find((c: Answer) => c.body === "Which Friday?");
  expect(root.anchor).toEqual({
    kind: "text",
    quote: "the beta on Friday",
    prefix: "Brief\nShip ",
    suffix: ".\nBudget is 10k.",
  });
  await stack.api(bea.jar, "POST", `/files/${id}/comments`, {
    body: "The 12th.",
    parentId: root.id,
  });

  const fetched = await call(agent, "drive_fetch", { id, comments: true });
  expect(fetched.metadata.comments[0]).toMatchObject({
    text: "Which Friday?",
    replies: [{ text: "The 12th." }],
  });

  const resolved = await call(agent, "drive_comment", { id, resolve: [root.id] });
  expect(resolved.threads.map((t: Answer) => t.text)).toEqual(["Looks good overall."]);
  const all = await call(agent, "drive_comment", { id, include_resolved: true });
  expect(all.threads[0]).toMatchObject({ text: "Which Friday?", resolved: true });
  const after = await stack.api(bea.jar, "GET", `/files/${id}/comments`);
  expect(after.body.comments.find((c: Answer) => c.id === root.id).resolvedAt).not.toBeNull();

  const outsider = await stack.member((await stack.company("elsewhere")).id);
  const outsiderAgent = await connectAgent(stack.worker.url, outsider.jar, { scope: WRITE });
  expect(
    (await call(outsiderAgent, "drive_comment", { id, add: [{ text: "hi" }] })).error,
  ).toBeDefined();
});

test("a batch of comments counts each change against the person's write limit", async () => {
  const acme = await stack.company("acme-limit");
  const ana = await stack.member(acme.id);
  const space = await stack.api(ana.jar, "POST", "/teamspaces", { name: "Ana", private: true });
  const teamspaceId = (space.body.teamspace as { id: string }).id;
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });
  const made = await call(agent, "drive_create_doc", {
    name: "Notes",
    teamspace_id: teamspaceId,
    markdown: "# Notes",
  });
  const twenty = Array.from({ length: 20 }, (_, i) => ({ text: `Point ${i}` }));
  const first = await call(agent, "drive_comment", { id: made.doc.id, add: twenty });
  expect(first.added).toHaveLength(20);
  const again = await call(agent, "drive_comment", { id: made.doc.id, add: twenty });
  expect(again.error).toContain("Too many changes");
  expect((await call(agent, "drive_comment", { id: made.doc.id })).threads).toHaveLength(20);
});

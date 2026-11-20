import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off", RATE_LIMIT_SEARCH: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const WRITE = "openid mail:read drive:read drive:write";

interface Doc {
  id: string;
  title: string;
  url: string;
}

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text };
  return result.structuredContent as { doc: Doc };
}

async function contentOf(person: Person, id: string) {
  return (await stack.download(person.jar, id)).text();
}

test("an agent writes a doc and edits it, only where its person may", async () => {
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const carl = await stack.member(acme.id);
  const anaAgent = await connectAgent(stack.worker.url, ana.jar, { scope: WRITE });

  const made = await call(anaAgent, "drive_create_doc", {
    name: "Launch plan",
    workspace: acme.id,
    markdown: "# Launch plan\n\n- [ ] Book the venue\n- [ ] Send invites",
  });
  if ("error" in made) throw new Error(made.error);
  expect(made.doc.title).toBe("Launch plan.md");
  expect(made.doc.url).toBe(`${WEB_ORIGIN}/${acme.slug}/files/my?file=${made.doc.id}`);
  expect(await contentOf(ana, made.doc.id)).toBe(
    "# Launch plan\n\n- [ ] Book the venue\n- [ ] Send invites",
  );

  const edited = await call(anaAgent, "drive_edit_doc", {
    id: made.doc.id,
    edits: [
      { find: "- [ ] Book the venue", replace: "- [x] Book the venue" },
      { find: "Send invites", replace: "Send invites by Friday" },
    ],
  });
  expect(edited).not.toHaveProperty("error");
  expect(await contentOf(ana, made.doc.id)).toBe(
    "# Launch plan\n\n- [x] Book the venue\n- [ ] Send invites by Friday",
  );

  const missed = await call(anaAgent, "drive_edit_doc", {
    id: made.doc.id,
    edits: [
      { find: "Send invites by Friday", replace: "Send invites today" },
      { find: "Order the cake", replace: "Order two cakes" },
    ],
  });
  expect(missed).toHaveProperty("error");
  expect((missed as { error: string }).error).toContain("Send invites by Friday");
  expect(await contentOf(ana, made.doc.id)).toContain("Send invites by Friday");

  expect(
    await call(anaAgent, "drive_edit_doc", {
      id: made.doc.id,
      edits: [
        { find: "Book the venue", replace: "Book the banana venue" },
        { find: "ana", replace: "x" },
      ],
    }),
  ).toHaveProperty("error");
  const grown = await call(anaAgent, "drive_edit_doc", {
    id: made.doc.id,
    edits: [{ find: "Send invites by Friday", replace: "x".repeat(1_000_001) }],
  });
  expect((grown as { error: string }).error).toContain("larger than 1 MB");
  expect(await contentOf(ana, made.doc.id)).toBe(
    "# Launch plan\n\n- [x] Book the venue\n- [ ] Send invites by Friday",
  );

  const carlAgent = await connectAgent(stack.worker.url, carl.jar, { scope: WRITE });
  expect(
    await call(carlAgent, "drive_edit_doc", { id: made.doc.id, markdown: "# Mine now" }),
  ).toHaveProperty("error");
  expect(await contentOf(ana, made.doc.id)).toContain("# Launch plan");

  const sheet = await stack.upload(ana.jar, { space: "personal" }, "notes.txt", new Uint8Array(3));
  expect(
    await call(anaAgent, "drive_edit_doc", { id: sheet.id, markdown: "# Not a doc" }),
  ).toHaveProperty("error");

  const reader = await connectAgent(stack.worker.url, ana.jar, {
    scope: "openid mail:read drive:read",
  });
  await expect(
    call(reader, "drive_create_doc", { name: "Nope", workspace: acme.id, markdown: "# Nope" }),
  ).rejects.toThrow(/drive:write/);
});

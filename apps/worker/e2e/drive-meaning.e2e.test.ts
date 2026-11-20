import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

const fixtures = new URL("../../../fixtures/drive/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("search.json", fixtures), "utf8")) as {
  files: { id: string; name: string; location: string; text: string }[];
};

interface Question {
  instructions: { file: { name: string } };
}

function recordedJudgments() {
  const dir = new URL("recordings/", fixtures);
  const byQuery = new Map<string, Map<string, number>>();
  for (const file of readdirSync(dir).filter((name) => name.startsWith("search-"))) {
    const { request, response } = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
      request: { state: { query: string }; questions: Record<string, Question> };
      response: { answers: Record<string, { noul: number }> };
    };
    const byName = new Map<string, number>();
    for (const [id, question] of Object.entries(request.questions)) {
      byName.set(question.instructions.file.name, response.answers[id]!.noul);
    }
    byQuery.set(request.state.query, byName);
  }
  return byQuery;
}

const uploadedName = (name: string) => `${name}.md`;
const recordedName = (name: string) => name.replace(/\.md$/, "");

const jev = { mode: "replay" as "replay" | "fail", requests: 0, sent: [] as string[] };
let server: Server;
let stack: StorageStack;

beforeAll(async () => {
  const judgments = recordedJudgments();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    jev.requests++;
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      state: { query: string };
      questions: Record<string, Question>;
    };
    jev.sent.push(...Object.values(body.questions).map((q) => q.instructions.file.name));
    const byName = judgments.get(body.state.query);
    const answers = Object.entries(body.questions).map(([id, q]) => [
      id,
      byName?.get(recordedName(q.instructions.file.name)),
    ]);
    if (jev.mode === "fail" || answers.some(([, noul]) => noul === undefined)) {
      res.writeHead(500).end("no recording for this request");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: body.model,
        answers: Object.fromEntries(answers.map(([id, noul]) => [id, { type: "noul", noul }])),
        usage: { input_tokens: 3_200, output_tokens: 0 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stack = await startStorageStack({
    vars: {
      WEB_APP_URL: WEB_ORIGIN,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_SEARCH: "off",
      TYPESAFE_API_URL: `http://127.0.0.1:${port}`,
    },
    secrets: { TYPESAFE_API_KEY: "recorded" },
  });
}, 120_000);
afterAll(async () => {
  await stack?.stop();
  server?.close();
});

interface Hit {
  id: string;
  title: string;
  match: "words" | "meaning";
}

async function search(agent: Client, query: string) {
  const result = await agent.callTool({ name: "drive_search", arguments: { query } });
  return (result.structuredContent as { results: Hit[] }).results;
}

const named = (hits: Hit[]) => hits.map((hit) => recordedName(hit.title));

async function seed(owner: Person) {
  const ids = new Map<string, string>();
  for (const file of fixture.files) {
    const space = file.location.endsWith("My files") ? "personal" : "shared";
    const node = await stack.upload(
      owner.jar,
      { space },
      uploadedName(file.name),
      new TextEncoder().encode(file.text),
    );
    ids.set(file.id, node.id);
  }
  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");
  return ids;
}

test("an agent finds files by what they are about, never one its person cannot open", async () => {
  const org = await stack.company("meaning");
  const ana = await stack.member(org.id);
  const carl = await stack.member(org.id);
  const ids = await seed(ana);
  const agent = await connectAgent(stack.worker.url, ana.jar, {
    scope: "openid mail:read drive:read",
    workspace: org.id,
  });

  const waterproofing = await search(agent, "waterproofing budget approval");
  expect(waterproofing[0]).toMatchObject({ id: ids.get("obra-minutes"), match: "meaning" });
  expect(named(waterproofing)).toEqual(["scan-0001.pdf"]);

  const rent = await search(agent, "office rent agreement");
  expect(rent[0]?.id).toBe(ids.get("office-lease"));

  const nda = await search(agent, "confidentiality contract with Brightside");
  expect(nda[0]?.id).toBe(ids.get("brightside-nda"));
  expect(named(nda)).not.toContain("Brightside redesign proposal v3.pptx");

  const dinner = await search(agent, "how much was the taco dinner");
  expect(dinner[0]?.id).toBe(ids.get("farolito-receipt"));

  const carlAgent = await connectAgent(stack.worker.url, carl.jar, {
    scope: "openid mail:read drive:read",
    workspace: org.id,
  });
  expect(named(await search(carlAgent, "how much was the taco dinner"))).not.toContain(
    "IMG_2041.jpg",
  );
  expect(named(await search(carlAgent, "october salaries"))).not.toContain("Nómina 2026-10.xlsx");
});

test("when the relevance judge fails, search answers with word matches alone", async () => {
  const org = await stack.company("fallback");
  const ana = await stack.member(org.id);
  const ids = await seed(ana);
  const agent = await connectAgent(stack.worker.url, ana.jar, {
    scope: "openid mail:read drive:read",
    workspace: org.id,
  });
  jev.mode = "fail";
  try {
    expect(await search(agent, "waterproofing budget approval")).toEqual([]);
    const words = await search(agent, "Brightside");
    expect(words.every((hit) => hit.match === "words")).toBe(true);
    expect(words.map((hit) => hit.id)).toContain(ids.get("brightside-nda"));
  } finally {
    jev.mode = "replay";
  }
});

test("a file under a trashed folder is never sent to the relevance judge, even to a person it was shared with", async () => {
  const acme = await stack.company("owner");
  const ana = await stack.member(acme.id);
  const other = await stack.company("guest");
  const bea = await stack.member(other.id);
  const lease = fixture.files.find((file) => file.id === "office-lease")!;
  const folder = await stack.api(ana.jar, "POST", "/folders", { name: "Legal", space: "shared" });
  const node = await stack.upload(
    ana.jar,
    { parentId: folder.body.node.id },
    uploadedName(lease.name),
    new TextEncoder().encode(lease.text),
  );
  const shared = await stack.api(
    ana.jar,
    "PUT",
    `/nodes/${node.id}/sharing/people/${encodeURIComponent(bea.email)}`,
    { role: "viewer" },
  );
  expect(shared.status).toBe(200);
  for (let run = 0; run < 3; run++) expect(await stack.cron("* * * * *")).toBe("ok");
  const agent = await connectAgent(stack.worker.url, bea.jar, {
    scope: "openid mail:read drive:read",
  });
  expect((await search(agent, "office rent agreement")).map((hit) => hit.id)).toEqual([node.id]);

  expect((await stack.api(ana.jar, "DELETE", `/nodes/${folder.body.node.id}`)).status).toBe(200);
  jev.sent = [];
  expect(await search(agent, "october salaries")).toEqual([]);
  expect(jev.sent).not.toContain(uploadedName(lease.name));
});

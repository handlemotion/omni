import { createServer, type Server } from "node:http";
import type { Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgent } from "./mcp-support.ts";
import {
  CookieJar,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

let cleanup: () => Promise<void>;
let worker: { url: string };
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
let agent: Client;
let userId: string;
const posted: unknown[] = [];

async function startWebhook() {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/hook`, close: () => server.close() };
}

beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  const mail = await startMailServiceEndpoint();
  const webhook = await startWebhook();
  const started = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mail.url,
    vars: { SYSTEM_MAIL_FROM, WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off" },
    secrets: { MCP_FEEDBACK_WEBHOOK_URL: webhook.url },
  });
  worker = { url: started.url.toString() };
  const org = await createOrg(db, "reporters");
  ({ userId } = await createMember(db, org.id, "ivy@reporters.test"));
  const jar = new CookieJar();
  await signIn(worker, db, "ivy@reporters.test", jar);
  agent = await connectAgent(worker.url, jar, { scope: "openid mail:read" });
  cleanup = async () => {
    await agent.close();
    await started.server.close();
    webhook.close();
    await mail.close();
    await database.teardown();
  };
}, 120_000);

afterAll(() => cleanup?.());

async function until<T>(read: () => T | undefined, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("an agent with only mail:read reports a problem: it is stored and reaches the webhook", async () => {
  const result = await agent.callTool({
    name: "report_feedback",
    arguments: {
      kind: "missing",
      tool: "search",
      summary: "search cannot filter by label",
      details:
        "Called search { query: '', view: 'inbox' } and had to fetch 30 threads to find labels.",
      proposed_fix: "Add a label filter to search.",
    },
  });
  expect(result.isError).toBeFalsy();
  const { feedback_id } = result.structuredContent as { feedback_id: string };

  const [row] = await db
    .select()
    .from(schema.agentFeedback)
    .where(eq(schema.agentFeedback.id, feedback_id));
  expect(row).toMatchObject({
    userId,
    kind: "missing",
    tool: "search",
    summary: "search cannot filter by label",
    proposedFix: "Add a label filter to search.",
  });
  expect(row!.clientId).not.toBe("");

  const sent = await until(() => posted.at(-1) as { text: string } | undefined);
  expect(sent.text).toContain("search cannot filter by label");
  expect(sent.text).toContain("Add a label filter to search.");
  expect(sent.text).toContain(feedback_id);
});

test("the server bundles the report-feedback skill, and its instructions point at the tool", async () => {
  expect(agent.getInstructions()).toContain("report_feedback");
  const skills = new SkillsClient(agent);
  expect(skills.supported).toBe(true);
  const { skills: entries } = await skills.list();
  const entry = entries.find((s) => s.frontmatter.name === "report-feedback");
  expect(entry?.uri).toBe("skill://report-feedback/SKILL.md");
  const file = await skills.read(entry!);
  expect(file.verified).toBe(true);
  expect(file.body).toContain("proposed_fix");
});

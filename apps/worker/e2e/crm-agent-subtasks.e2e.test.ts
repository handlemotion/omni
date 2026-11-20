import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";
import { connectAgent } from "./mcp-support.ts";
import { WEB_ORIGIN } from "./support.ts";

let stack: CrmStack;
beforeAll(async () => {
  stack = await startCrmStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off" },
  });
}, 120_000);
afterAll(() => stack?.stop());

const CRM = "openid mail:read crm:read crm:write";

async function call<T = Record<string, unknown>>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const answer = await agent.callTool({ name, arguments: args });
  if (answer.isError) throw new Error(JSON.stringify(answer.content));
  return answer.structuredContent as T;
}

type Step = { id: string; title: string; done: boolean };
type TaskAnswer = { task: { id: string; subtasks: Step[] } };

test("an agent adds a task with a checklist, ticks a step and reads it back in order", async () => {
  const org = await stack.company("agentsteps");
  const ana = await stack.member(org.id, "owner");
  const agent = await connectAgent(stack.worker.url, ana.jar, { scope: CRM });

  const added = await call<TaskAnswer>(agent, "crm_write", {
    task: { title: "Deliver the cut", subtasks: [{ title: "Color" }, { title: "Sound mix" }] },
  });
  const [color, sound] = added.task.subtasks;
  expect(added.task.subtasks).toMatchObject([
    { title: "Color", done: false },
    { title: "Sound mix", done: false },
  ]);

  await call(agent, "crm_write", {
    task: {
      id: added.task.id,
      subtasks: [
        { id: color!.id, title: "Color", done: true },
        { id: sound!.id, title: "Sound mix", done: false },
        { title: "Subtitles" },
      ],
    },
  });
  const listed = await call<{ tasks: { id: string; subtasks: Step[] }[] }>(agent, "crm_tasks", {});
  expect(listed.tasks.find((t) => t.id === added.task.id)!.subtasks).toMatchObject([
    { id: color!.id, title: "Color", done: true },
    { id: sound!.id, title: "Sound mix", done: false },
    { title: "Subtitles", done: false },
  ]);
});

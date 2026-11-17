/* oxlint-disable no-console -- a CLI report */
import { writeFileSync } from "node:fs";
import { createJevClient, jevTriageRequest, triage } from "../src/index.ts";
import { helpdeskRecordingUrl, helpdeskSteps } from "./helpdesk-scenarios.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("Set TYPESAFE_API_KEY to record.");
  process.exit(1);
}

let misses = 0;
for (const step of await helpdeskSteps()) {
  let response: unknown = null;
  const client = createJevClient({
    apiKey,
    fetch: async (url, init) => {
      const live = await fetch(url, init);
      response = await live.clone().json();
      return live;
    },
  });
  const result = await triage(client, step.input);
  const got = {
    bucket: result.bucket,
    priority: result.helpdesk?.priority,
    tags: result.helpdesk?.tagIds ?? [],
    assignee: result.helpdesk?.assigneeId ?? null,
  };
  const ok = JSON.stringify(got) === JSON.stringify(step.expect);
  if (!ok) misses++;
  const request = jevTriageRequest(step.input, client.model);
  writeFileSync(
    helpdeskRecordingUrl(step.id),
    JSON.stringify({ request, response }, null, 2) + "\n",
  );
  const answers = (response as { answers: Record<string, { noul: number }> }).answers;
  const nouls = Object.entries(answers)
    .map(([k, a]) => `${k}=${a.noul.toFixed(3)}`)
    .join(" ");
  console.log(
    `${ok ? "PASS" : "MISS"} ${step.id.padEnd(28)} ${JSON.stringify(got)} @ ${result.confidence.toFixed(3)}\n     expected ${JSON.stringify(step.expect)}\n     ${nouls}`,
  );
}
console.log(misses === 0 ? "\nAll steps as expected." : `\n${misses} step(s) missed.`);

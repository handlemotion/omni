// Records live Jev answers for the triage scenarios: `pnpm --filter @omni/ai record` (under
// Doppler, or with TYPESAFE_API_KEY set). Never part of `test` or CI. Sends only the invented
// fixture threads in `fixtures/eml/triage-*.eml`; costs a fraction of a cent per run.
/* oxlint-disable no-console -- a CLI report */
import { writeFileSync } from "node:fs";
import { createJevClient, jevTriageRequest, laneFor, triage } from "../src/index.ts";
import { recordingUrl, scenarioSteps } from "./scenarios.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("Set TYPESAFE_API_KEY to record.");
  process.exit(1);
}

let misses = 0;
for (const step of await scenarioSteps()) {
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
  const lane = laneFor(result);
  if (lane !== step.lane) misses++;

  if (result.source === "rule") {
    console.log(`${step.id.padEnd(16)} rule → ${lane}`);
    continue;
  }
  const request = jevTriageRequest(step.input, client.model);
  writeFileSync(recordingUrl(step.id), JSON.stringify({ request, response }, null, 2) + "\n");
  const answers = (response as { answers: Record<string, { noul: number }> }).answers;
  const nouls = Object.entries(answers)
    .map(([k, a]) => `${k}=${a.noul.toFixed(3)}`)
    .join(" ");
  console.log(
    `${lane === step.lane ? "PASS" : "MISS"} ${step.id.padEnd(16)} ${result.bucket} @ ${result.confidence.toFixed(3)} → lane ${lane} (expected ${step.lane})\n     ${nouls}`,
  );
}
console.log(misses === 0 ? "\nAll steps in their expected lane." : `\n${misses} step(s) missed.`);

/* oxlint-disable no-console -- a CLI report */
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  nameSpeakers,
  namingPrompt,
  notesPrompt,
  renderTranscript,
  writeNotes,
} from "../src/index.ts";
import { meetingsRecordingUrl, namingScenarios, notesScenarios } from "./meetings-scenarios.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to record.");
  process.exit(1);
}

function recordingClient() {
  const seen: { response: unknown } = { response: null };
  const client = new Anthropic({
    apiKey,
    fetch: async (url, init) => {
      const live = await fetch(url, init);
      seen.response = await live.clone().json();
      return live;
    },
  });
  return { client, seen };
}

for (const { id, input, holds } of notesScenarios) {
  const { client, seen } = recordingClient();
  const started = performance.now();
  const result = await writeNotes(client, input);
  const ms = Math.round(performance.now() - started);
  const user = notesPrompt(input, renderTranscript(input.turns, input.titles));
  writeFileSync(
    meetingsRecordingUrl(id),
    JSON.stringify({ user, response: seen.response }, null, 2) + "\n",
  );
  console.log(
    `${result.ok ? "OK" : "FAIL"} ${id}: ${ms} ms, ${result.usage.tokensIn} in / ${result.usage.tokensOut} out`,
  );
  console.log(JSON.stringify(result.ok ? result.notes : result, null, 2).replace(/^/gm, "     "));
  console.log(`     expected: ${JSON.stringify(holds)}`);
}

for (const { id, input, expect } of namingScenarios) {
  const { client, seen } = recordingClient();
  const result = await nameSpeakers(client, input);
  writeFileSync(
    meetingsRecordingUrl(id),
    JSON.stringify({ user: namingPrompt(input), response: seen.response }, null, 2) + "\n",
  );
  const got = Object.fromEntries(result.named.map((s) => [s.label, s.address]));
  console.log(`${id}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
}

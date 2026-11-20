/* oxlint-disable no-console -- a CLI report */
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ocrRequest, transcribe } from "../src/index.ts";
import { ocrRecordingUrl, ocrScenarios, withoutFileData } from "./ocr-scenarios.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to record.");
  process.exit(1);
}

for (const { id, source, holds } of ocrScenarios) {
  let response: unknown = null;
  const client = new Anthropic({
    apiKey,
    fetch: async (url, init) => {
      const live = await fetch(url, init);
      response = await live.clone().json();
      return live;
    },
  });
  const started = performance.now();
  const transcript = await transcribe(client, source);
  const ms = Math.round(performance.now() - started);
  const request = withoutFileData(ocrRequest(source));
  writeFileSync(ocrRecordingUrl(id), JSON.stringify({ request, response }, null, 2) + "\n");
  const missing = holds.filter((word) => !transcript.text.includes(word));
  console.log(
    `${missing.length ? "MISS" : "PASS"} ${id}: ${ms} ms, ${transcript.usage.tokensIn} in / ${transcript.usage.tokensOut} out${missing.length ? `, missing ${missing.join(", ")}` : ""}`,
  );
  console.log(transcript.text.replace(/^/gm, "     "));
}

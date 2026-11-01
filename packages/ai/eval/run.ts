// Opt-in eval against the real APIs: `pnpm --filter @omni/ai eval`. Never part of `test` or CI.
// Runs the synthetic threads through Jev and Claude side by side, for whichever keys are set
// (TYPESAFE_API_KEY, ANTHROPIC_API_KEY). Costs a few cents per run; sends only `threads.ts`.
/* oxlint-disable no-console -- a CLI report */
import Anthropic from "@anthropic-ai/sdk";
import { createJevClient, laneFor, summarize, triage, type TriageClient } from "../src/index.ts";
import { threads } from "./threads.ts";

const providers: Array<{ name: string; client: TriageClient }> = [];
if (process.env.TYPESAFE_API_KEY) {
  providers.push({
    name: "jev",
    client: createJevClient({ apiKey: process.env.TYPESAFE_API_KEY }),
  });
}
const anthropic =
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;
if (anthropic) providers.push({ name: "claude", client: anthropic });

if (providers.length === 0) {
  console.error("Set TYPESAFE_API_KEY and/or ANTHROPIC_API_KEY to run the eval.");
  process.exit(1);
}

const totals = new Map(providers.map((p) => [p.name, { correct: 0, filed: 0, tokensIn: 0 }]));

for (const thread of threads) {
  console.log(`\n${thread.name}  (expected ${thread.expected})`);
  for (const { name, client } of providers) {
    const result = await triage(client, thread.input);
    const lane = laneFor(result);
    const total = totals.get(name) ?? { correct: 0, filed: 0, tokensIn: 0 };
    total.tokensIn += result.usage.tokensIn;
    if (result.bucket === thread.expected) total.correct++;
    if (lane !== "unsure") total.filed++;
    console.log(
      [
        `  ${result.bucket === thread.expected ? "PASS" : "MISS"} ${name.padEnd(6)}`,
        `${result.bucket.padEnd(15)} ${result.confidence.toFixed(2)}`,
        `lane=${lane}`.padEnd(22),
        `source=${result.source}`,
        result.model ?? "",
      ].join("  "),
    );
  }

  if (anthropic && thread.expected !== "noise") {
    const s = await summarize(anthropic, {
      subject: thread.input.subject,
      messages: [{ from: thread.input.from.address, text: thread.input.latestText }],
    });
    console.log(`  summary: ${s.summary ?? "(none)"}`);
  }
}

console.log("");
for (const [name, t] of totals) {
  console.log(
    `${name}: ${t.correct}/${threads.length} correct · ${t.filed} auto-filed · ${t.tokensIn} tokens in`,
  );
}

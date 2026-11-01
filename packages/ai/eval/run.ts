// Opt-in eval against the real API: `pnpm --filter @omni/ai eval`. Never part of `test` or CI.
// Needs ANTHROPIC_API_KEY (or an `ant auth login` profile); costs a few cents per run.
/* oxlint-disable no-console -- a CLI report */
import Anthropic from "@anthropic-ai/sdk";
import { laneFor, shouldSummarize, summarize, triage, type Bucket } from "../src/index.ts";
import { threads } from "./threads.ts";

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Set ANTHROPIC_API_KEY to run the eval.");
  process.exit(1);
}

const client = new Anthropic();
let correct = 0;
let tokensIn = 0;
let tokensOut = 0;

for (const thread of threads) {
  const result = await triage(client, thread.input);
  tokensIn += result.usage.tokensIn;
  tokensOut += result.usage.tokensOut;
  const ok = result.bucket === thread.expected;
  if (ok) correct++;

  let summary = "";
  const decision = shouldSummarize({
    bucket: result.bucket,
    usage: { tokensIn, tokensOut },
    dailyTokenCap: 1_000_000,
  });
  if (decision.run) {
    const s = await summarize(client, {
      subject: thread.input.subject,
      messages: [{ from: thread.input.from.address, text: thread.input.latestText }],
    });
    tokensIn += s.usage.tokensIn;
    tokensOut += s.usage.tokensOut;
    summary = s.summary ?? "(no summary)";
  } else {
    summary = `(skipped: ${decision.reason})`;
  }

  console.log(
    [
      ok ? "PASS" : "MISS",
      thread.name.padEnd(28),
      `${result.bucket.padEnd(15)} ${result.confidence.toFixed(2)}`,
      `lane=${laneFor(result)}`.padEnd(22),
      `source=${result.source}`,
      `expected=${thread.expected satisfies Bucket}`,
    ].join("  "),
  );
  console.log(`      ${summary}`);
}

console.log(`\n${correct}/${threads.length} correct · ${tokensIn} tokens in · ${tokensOut} out`);

/* oxlint-disable no-console -- a CLI report */
import { writeFileSync } from "node:fs";
import {
  createJevClient,
  jevFileSearchRequest,
  judgeFileRelevance,
  rankByRelevance,
} from "../src/index.ts";
import {
  driveSearchCandidates,
  driveSearchFixture,
  driveSearchNow,
  driveSearchRecordingUrl,
} from "./drive-search-scenarios.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("Set TYPESAFE_API_KEY to record.");
  process.exit(1);
}

let jevTop1 = 0;
let newestTop1 = 0;
let reciprocalRank = 0;
for (const { id, query, best } of driveSearchFixture.queries) {
  let response: unknown = null;
  const client = createJevClient({
    apiKey,
    fetch: async (url, init) => {
      const live = await fetch(url, init);
      response = await live.clone().json();
      return live;
    },
  });
  const started = performance.now();
  const { relevance, tokensIn } = await judgeFileRelevance(client, query, driveSearchCandidates, {
    now: driveSearchNow,
  });
  const ms = Math.round(performance.now() - started);
  const request = jevFileSearchRequest(query, driveSearchCandidates, {
    now: driveSearchNow,
    model: client.model,
  });
  writeFileSync(driveSearchRecordingUrl(id), JSON.stringify({ request, response }, null, 2) + "\n");

  const ranked = rankByRelevance(driveSearchCandidates, relevance);
  const rank = ranked.findIndex((c) => c.id === best) + 1;
  if (rank === 1) jevTop1++;
  if (driveSearchCandidates[0]?.id === best) newestTop1++;
  reciprocalRank += 1 / rank;
  console.log(
    `${rank === 1 ? "PASS" : "MISS"} "${query}" → ${ranked[0]?.id} (want ${best}, at #${rank}) ${ms} ms, ${tokensIn} tokens`,
  );
  for (const c of ranked.slice(0, 4))
    console.log(`     ${relevance.get(c.id)?.toFixed(3)} ${c.id}`);
}
const n = driveSearchFixture.queries.length;
console.log(
  `\nTop-1: Jev ${jevTop1}/${n}, newest-first ${newestTop1}/${n}. Jev MRR ${(reciprocalRank / n).toFixed(2)}.`,
);

// Search relevance against Jev answers recorded live (`pnpm --filter @omni/ai record:search`),
// replayed through an injected fetch. No network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  searchCandidates,
  searchFixture,
  searchNow,
  searchRecordingUrl,
} from "../eval/search-scenarios.ts";
import {
  createJevClient,
  describeDate,
  jevSearchRequest,
  JevError,
  judgeRelevance,
  rankByRelevance,
} from "./index.ts";

function recorded(id: string) {
  return JSON.parse(readFileSync(searchRecordingUrl(id), "utf8")) as {
    request: unknown;
    response: { answers: Record<string, unknown> };
  };
}

function replay(response: unknown) {
  return createJevClient({ apiKey: "recorded", fetch: async () => Response.json(response) });
}

describe.each(searchFixture.queries)('"$query"', ({ id, query, best }) => {
  const recording = recorded(id);

  it("still sends the request the answers were recorded for", () => {
    // A failure here means the wording, the state, or the fixture changed: re-record and check
    // the right thread still comes first.
    expect(jevSearchRequest(query, searchCandidates, { now: searchNow })).toEqual(
      recording.request,
    );
  });

  it(`puts ${best} first`, async () => {
    const { relevance } = await judgeRelevance(
      replay(recording.response),
      query,
      searchCandidates,
      {
        now: searchNow,
      },
    );
    expect(rankByRelevance(searchCandidates, relevance)[0]?.id).toBe(best);
  });
});

describe("relevance", () => {
  it("throws when an answer is missing instead of ranking the thread as irrelevant", async () => {
    const { response } = recorded(searchFixture.queries[0]!.id);
    const { candidate_3: _dropped, ...answers } = response.answers;
    await expect(
      judgeRelevance(replay({ ...response, answers }), "q", searchCandidates, { now: searchNow }),
    ).rejects.toThrow(JevError);
  });

  it("ranks judged candidates by probability and keeps unjudged ones after, in text order", () => {
    const ids = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const relevance = new Map([
      ["c", 0.9],
      ["a", 0.2],
      ["b", 0.9],
    ]);
    expect(rankByRelevance(ids, relevance).map((c) => c.id)).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("states how long ago a message was by calendar day, in UTC", () => {
    const now = new Date("2026-11-03T00:30:00Z");
    expect(describeDate(new Date("2026-11-02T23:59:00Z"), now)).toBe(
      "November 2, 2026 (yesterday)",
    );
    expect(describeDate(new Date("2026-11-03T00:01:00Z"), now)).toBe("November 3, 2026 (today)");
    expect(describeDate(new Date("2026-10-06T09:00:00Z"), now)).toBe(
      "October 6, 2026 (4 weeks ago)",
    );
    expect(describeDate(new Date("2026-08-04T09:00:00Z"), now)).toBe(
      "August 4, 2026 (2 months ago)",
    );
  });
});

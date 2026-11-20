import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  driveSearchCandidates,
  driveSearchFixture,
  driveSearchNow,
  driveSearchRecordingUrl,
} from "../eval/drive-search-scenarios.ts";
import {
  createJevClient,
  jevFileSearchRequest,
  judgeFileRelevance,
  rankByRelevance,
} from "./index.ts";

function recorded(id: string) {
  return JSON.parse(readFileSync(driveSearchRecordingUrl(id), "utf8")) as {
    request: unknown;
    response: unknown;
  };
}

function replay(response: unknown) {
  return createJevClient({ apiKey: "recorded", fetch: async () => Response.json(response) });
}

describe.each(driveSearchFixture.queries)('"$query"', ({ id, query, best }) => {
  const recording = recorded(id);

  it("still sends the request the answers were recorded for", () => {
    expect(jevFileSearchRequest(query, driveSearchCandidates, { now: driveSearchNow })).toEqual(
      recording.request,
    );
  });

  it(`puts ${best} first though their words differ`, async () => {
    const { relevance } = await judgeFileRelevance(
      replay(recording.response),
      query,
      driveSearchCandidates,
      { now: driveSearchNow },
    );
    expect(rankByRelevance(driveSearchCandidates, relevance)[0]?.id).toBe(best);
  });
});

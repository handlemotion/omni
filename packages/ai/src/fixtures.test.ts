// The triage scenarios in `fixtures/triage/` against Jev answers recorded live (see that
// folder's README). Each step is the thread up to one real `.eml`, parsed and cleaned the way the
// mail service stores it. No network: the recorded response comes back through an injected fetch.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordingUrl, scenarioSteps } from "../eval/scenarios.ts";
import { createJevClient, jevTriageRequest, laneFor, triage } from "./index.ts";

const steps = await scenarioSteps();

describe.each(steps)("$id ($eml)", ({ id, input, lane }) => {
  const recording = JSON.parse(readFileSync(recordingUrl(id), "utf8")) as {
    request: unknown;
    response: unknown;
  };

  it("still sends the request the answers were recorded for", () => {
    // A failure here means the questions, the state, or the fixture changed: re-record
    // (`pnpm --filter @omni/ai record`) and check the new answers still land in the lane.
    expect(jevTriageRequest(input)).toEqual(recording.request);
  });

  it(`lands in ${lane}`, async () => {
    const client = createJevClient({
      apiKey: "recorded",
      fetch: async () => Response.json(recording.response),
    });
    expect(laneFor(await triage(client, input))).toBe(lane);
  });
});

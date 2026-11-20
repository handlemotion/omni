import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ocrRecordingUrl, ocrScenarios, withoutFileData } from "../eval/ocr-scenarios.ts";
import { ocrRequest, transcribe } from "./ocr.ts";

const replaying = (response: Anthropic.Message) =>
  ({
    messages: { create: async () => response },
  }) as unknown as Parameters<typeof transcribe>[0];

describe.each(ocrScenarios)("$id", ({ id, source, holds }) => {
  const recording = JSON.parse(readFileSync(ocrRecordingUrl(id), "utf8")) as {
    request: unknown;
    response: Anthropic.Message;
  };

  it("still sends the request the transcript was recorded for", () => {
    expect(withoutFileData(ocrRequest(source))).toEqual(recording.request);
  });

  it("reads the file's words", async () => {
    const transcript = await transcribe(replaying(recording.response), source);
    for (const word of holds) expect(transcript.text).toContain(word);
    expect(transcript.truncated).toBe(false);
  });
});

it("marks a transcript the token cap cut as truncated, keeping what was read", async () => {
  const { id, source } = ocrScenarios[0]!;
  const { response } = JSON.parse(readFileSync(ocrRecordingUrl(id), "utf8")) as {
    response: Anthropic.Message;
  };
  const cut = await transcribe(replaying({ ...response, stop_reason: "max_tokens" }), source);
  expect(cut.truncated).toBe(true);
  expect(cut.text).toContain("FAROLITO");
});

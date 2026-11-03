// The triage scenarios in `fixtures/triage/threads.json`, each step turned into the exact
// `TriageInput` production builds: parsed and cleaned by `@omni/mail-core` the way the mail
// service stores a message, then shaped by `triageInputFor` the way the queue consumer does.
import { readFileSync } from "node:fs";
import { parseMessage } from "@omni/mail-core";
import { cleanMessage } from "@omni/mail-core/clean";
import { triageInputFor, type ThreadMessage } from "../src/input.ts";
import type { Lane } from "../src/policy.ts";
import type { TriageInput } from "../src/types.ts";

const root = new URL("../../../fixtures/", import.meta.url);

interface Manifest {
  reader: string;
  threads: Array<{ name: string; messages: Array<{ eml: string; lane: Lane }> }>;
}

export interface Step {
  /** `<thread>-<n>`, n counting messages from 1. Names the recording. */
  id: string;
  eml: string;
  lane: Lane;
  input: TriageInput;
}

export const recordingUrl = (id: string) => new URL(`triage/recordings/${id}.json`, root);

async function stored(eml: string): Promise<ThreadMessage> {
  const { message } = await parseMessage(readFileSync(new URL(`eml/${eml}`, root)));
  return {
    fromName: message.from?.name || null,
    fromAddress: message.from?.address ?? "",
    subject: message.subject,
    cleanText: cleanMessage(message).cleanText,
  };
}

export async function scenarioSteps(): Promise<Step[]> {
  const manifest = JSON.parse(
    readFileSync(new URL("triage/threads.json", root), "utf8"),
  ) as Manifest;
  const isUs = (address: string) => address.toLowerCase() === manifest.reader;
  const steps: Step[] = [];
  for (const thread of manifest.threads) {
    const messages: ThreadMessage[] = [];
    for (const [i, { eml, lane }] of thread.messages.entries()) {
      messages.push(await stored(eml));
      steps.push({
        id: `${thread.name}-${i + 1}`,
        eml,
        lane,
        input: triageInputFor(messages, isUs),
      });
    }
  }
  return steps;
}

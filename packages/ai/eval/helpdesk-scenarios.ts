// The helpdesk triage scenarios in `fixtures/triage/helpdesk.json`: a customer's messages to a
// shared support inbox, with its tags and teammates, each step turned into the exact `TriageInput`
// the queue builds (tags in name order, teammates in role order, as `@omni/db` loads them).
import { readFileSync } from "node:fs";
import { parseMessage } from "@omni/mail-core";
import { cleanMessage } from "@omni/mail-core/clean";
import { triageInputFor, type ThreadMessage } from "../src/input.ts";
import type { Bucket, Priority, TriageInput } from "../src/types.ts";

const root = new URL("../../../fixtures/", import.meta.url);

export interface HelpdeskExpect {
  bucket: Bucket;
  priority: Priority;
  /** Tag names. */
  tags: string[];
  /** A teammate's `key`, or null for nobody. */
  assignee: string | null;
}

export interface HelpdeskManifest {
  inbox: string;
  tags: Array<{ name: string; description?: string }>;
  teammates: Array<{ key: string; role: string }>;
  threads: Array<{ name: string; messages: Array<{ eml: string; expect: HelpdeskExpect }> }>;
}

export interface HelpdeskStep {
  /** `helpdesk-<thread>-<n>`. Names the recording. */
  id: string;
  eml: string;
  expect: HelpdeskExpect;
  input: TriageInput;
}

export const helpdeskManifest = () =>
  JSON.parse(readFileSync(new URL("triage/helpdesk.json", root), "utf8")) as HelpdeskManifest;

export const helpdeskRecordingUrl = (id: string) => new URL(`triage/recordings/${id}.json`, root);

async function stored(eml: string): Promise<ThreadMessage> {
  const { message } = await parseMessage(readFileSync(new URL(`eml/${eml}`, root)));
  return {
    fromName: message.from?.name || null,
    fromAddress: message.from?.address ?? "",
    subject: message.subject,
    cleanText: cleanMessage(message).cleanText,
  };
}

export async function helpdeskSteps(): Promise<HelpdeskStep[]> {
  const manifest = helpdeskManifest();
  const isUs = (address: string) => address.toLowerCase() === manifest.inbox;
  const helpdesk = {
    // Tag ids and member ids never reach the model; names and keys stand in for them here.
    tags: manifest.tags.map((t) => ({ id: t.name, name: t.name, description: t.description })),
    teammates: manifest.teammates.map((t) => ({ id: t.key, role: t.role })),
  };
  const steps: HelpdeskStep[] = [];
  for (const thread of manifest.threads) {
    const messages: ThreadMessage[] = [];
    for (const [i, { eml, expect }] of thread.messages.entries()) {
      messages.push(await stored(eml));
      steps.push({
        id: `helpdesk-${thread.name}-${i + 1}`,
        eml,
        expect,
        input: { ...triageInputFor(messages, isUs), helpdesk },
      });
    }
  }
  return steps;
}

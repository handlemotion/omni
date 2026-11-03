// The search scenarios in `fixtures/search/threads.json`: invented threads, and queries a person
// might type with the thread they are after. Candidates go to Jev newest first, the order a
// full-text match of a common word comes back in, so the recorded answers have to do the work.
import { readFileSync } from "node:fs";
import type { SearchCandidate } from "../src/search.ts";

const root = new URL("../../../fixtures/search/", import.meta.url);

export interface SearchFixture {
  now: string;
  mailbox: string;
  threads: Array<{
    id: string;
    subject: string;
    from: { name: string | null; address: string };
    sentAt: string;
    messageCount: number;
    text: string;
  }>;
  queries: Array<{ id: string; query: string; best: string }>;
}

export const searchFixture = JSON.parse(
  readFileSync(new URL("threads.json", root), "utf8"),
) as SearchFixture;

export const searchNow = new Date(searchFixture.now);

export const searchRecordingUrl = (id: string) => new URL(`recordings/${id}.json`, root);

/** Every fixture thread as a candidate, newest first. */
export const searchCandidates: SearchCandidate[] = searchFixture.threads
  .map((t) => ({
    id: t.id,
    subject: t.subject,
    from: t.from,
    sentAt: new Date(t.sentAt),
    mailbox: searchFixture.mailbox,
    messageCount: t.messageCount,
    excerpt: t.text,
  }))
  .toSorted((a, b) => b.sentAt.getTime() - a.sentAt.getTime());

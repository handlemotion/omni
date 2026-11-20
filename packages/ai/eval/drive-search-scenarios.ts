import { readFileSync } from "node:fs";
import type { FileCandidate } from "../src/search.ts";

const root = new URL("../../../fixtures/drive/", import.meta.url);

export interface DriveSearchFixture {
  now: string;
  files: Array<{ id: string; name: string; location: string; modifiedAt: string; text: string }>;
  queries: Array<{ id: string; query: string; best: string }>;
}

export const driveSearchFixture = JSON.parse(
  readFileSync(new URL("search.json", root), "utf8"),
) as DriveSearchFixture;

export const driveSearchNow = new Date(driveSearchFixture.now);

export const driveSearchRecordingUrl = (id: string) =>
  new URL(`recordings/search-${id}.json`, root);

/** Every fixture file as a candidate, newest first, as the recent-files pool sends them. */
export const driveSearchCandidates: FileCandidate[] = driveSearchFixture.files
  .map((file) => ({
    id: file.id,
    name: file.name,
    location: file.location,
    modifiedAt: new Date(file.modifiedAt),
    excerpt: file.text,
  }))
  .toSorted((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

import {
  latestEpochStart,
  liveStartOf,
  storageLiveRecordSchema,
  type StorageLiveEntry,
} from "@omni/contracts";
import { docStream } from "../realtime-docs.ts";
import type { S2Basin, S2Record } from "../s2.ts";

const TAIL_WINDOW = 1000;

/** The records that are live document records, parsed; others are skipped. */
export function liveEntries(records: S2Record[]) {
  const entries: StorageLiveEntry[] = [];
  for (const { seqNum, body } of records) {
    let parsed;
    try {
      parsed = storageLiveRecordSchema.safeParse(JSON.parse(body));
    } catch {
      continue;
    }
    if (parsed.success) entries.push({ seqNum, record: parsed.data });
  }
  return entries;
}

/** One page of the document's records from `from`. */
export async function readLivePage(basin: S2Basin, nodeId: string, from: number) {
  const page = await basin.read(docStream(nodeId), from);
  return { entries: liveEntries(page.records), more: page.more, last: page.records.at(-1) };
}

/** Every record of the document from `from`. */
export async function readLive(basin: S2Basin, nodeId: string, from: number) {
  const entries: StorageLiveEntry[] = [];
  for (let at = from; ;) {
    const page = await readLivePage(basin, nodeId, at);
    entries.push(...page.entries);
    if (!page.more || !page.last) return entries;
    at = page.last.seqNum + 1;
  }
}

/**
 * The first record a reader of the latest epoch needs: its latest `seed`, or the records after
 * those its latest `snap` holds. Looks at the stream's tail first, so it costs one read however
 * long the document has been edited; only a stream written before snaps is read from its start.
 */
export async function latestLiveStart(basin: S2Basin, nodeId: string) {
  const tail = liveEntries(await basin.readTail(docStream(nodeId), TAIL_WINDOW));
  const found = latestEpochStart(tail);
  if (found) return liveStartOf(found);
  if ((tail[0]?.seqNum ?? 0) === 0) return 0;
  const all = latestEpochStart(await readLive(basin, nodeId, 0));
  return all ? liveStartOf(all) : 0;
}

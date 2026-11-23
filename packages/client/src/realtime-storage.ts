import type {
  StorageChangedEvent,
  StorageDocEvent,
  StorageFilePresenceEvent,
  StorageLiveRecord,
  StorageTeamspacesChangedEvent,
} from "@omni/contracts";
import { isId, isObject, isSeqNum, keyOf } from "./realtime-guards.ts";

/** `STORAGE_DOC_PRESENCE_MAX` in `@omni/contracts`, without pulling its schemas in. */
export const DOC_PRESENCE_MAX = 4096;

type DocRefusal = Extract<StorageDocEvent, { type: "doc.refused" }>["reason"];

const isDocRefusal = keyOf<DocRefusal>({
  tail: true,
  editing: true,
  denied: true,
  locked: true,
  unavailable: true,
  read_only: true,
  rate: true,
});

const partsOf = (n: unknown) =>
  typeof n === "number" && Number.isInteger(n) && n >= 2 ? { n } : n === undefined ? {} : null;

const parseWriterRecord: (record: Record<string, unknown>) => StorageLiveRecord | undefined = (
  record,
) => {
  const { t, cv, e, u, s, f, n } = record;
  const parts = partsOf(n);
  if (typeof u !== "string" || !parts) return undefined;
  if (t === "seed" && isSeqNum(cv)) return { t, cv, u, ...parts };
  if (t === "update" && isSeqNum(e)) return { t, e, u, ...parts };
  if (t === "snap" && isSeqNum(e) && isSeqNum(s) && isSeqNum(cv) && isSeqNum(f)) {
    return { t, e, s, cv, f, u, ...parts };
  }
  return undefined;
};

const parseLiveRecord: (value: unknown) => StorageLiveRecord | undefined = (value) => {
  if (!isObject(value)) return undefined;
  const written = parseWriterRecord(value);
  if (written) return written;
  const { t, cv, e, u, s, h, i } = value;
  if (t === "more" && isSeqNum(h) && isSeqNum(i) && i >= 1 && typeof u === "string") {
    return { t, h, i, u };
  }
  if (t === "fold" && isSeqNum(e) && isSeqNum(cv) && isSeqNum(s)) return { t, e, cv, s };
  return undefined;
};

const driveOf: (
  space: unknown,
  teamspaceId: unknown,
) => Pick<StorageChangedEvent, "space" | "teamspaceId"> | undefined = (space, teamspaceId) => {
  if (space === "teamspace") {
    return isId(teamspaceId) ? { space: "teamspace", teamspaceId } : undefined;
  }
  return space === "personal" || space === "shared" ? { space } : undefined;
};

const parseDriveChanged: (event: Record<string, unknown>) => StorageChangedEvent | undefined = (
  event,
) => {
  const { space, teamspaceId, parentIds } = event;
  const drive = driveOf(space, teamspaceId);
  if (!drive) return undefined;
  if (!Array.isArray(parentIds)) return { type: "storage.changed", ...drive };
  const named = parentIds.filter((p): p is string | null => p === null || isId(p));
  return { type: "storage.changed", ...drive, parentIds: named };
};

type NodeEvent = StorageFilePresenceEvent | StorageDocEvent;
type NodeEventParser = (nodeId: string, event: Record<string, unknown>) => NodeEvent | undefined;

const NODE_EVENT_PARSERS: Record<NodeEvent["type"], NodeEventParser> = {
  "file.presence": (nodeId, { memberId, state }) =>
    isId(memberId) && (state === "editing" || state === "left")
      ? { type: "file.presence", nodeId, memberId, state }
      : undefined,
  "doc.appended": (nodeId, { ref, seqNum }) =>
    Number.isInteger(ref) && isSeqNum(seqNum)
      ? { type: "doc.appended", nodeId, ref: ref as number, seqNum }
      : undefined,
  "doc.refused": (nodeId, { ref, reason }) =>
    Number.isInteger(ref) && isDocRefusal(reason)
      ? { type: "doc.refused", nodeId, ref: ref as number, reason }
      : undefined,
  "doc.record": (nodeId, { seqNum, record }) => {
    const parsed = parseLiveRecord(record);
    return isSeqNum(seqNum) && parsed
      ? { type: "doc.record", nodeId, seqNum, record: parsed }
      : undefined;
  },
  "doc.presence": (nodeId, { u }) =>
    typeof u === "string" && u.length <= DOC_PRESENCE_MAX
      ? { type: "doc.presence", nodeId, u }
      : undefined,
  "doc.access": (nodeId, { role }) =>
    role === null || role === "editor" || role === "commenter"
      ? { type: "doc.access", nodeId, role }
      : undefined,
  "doc.comments": (nodeId) => ({ type: "doc.comments", nodeId }),
};

const isNodeEventType = keyOf(NODE_EVENT_PARSERS);

/** A Drive event off the socket: a listing changed, or a file's presence or live document. */
export const parseStorageEvent: (
  event: Record<string, unknown>,
) =>
  | StorageFilePresenceEvent
  | StorageDocEvent
  | StorageChangedEvent
  | StorageTeamspacesChangedEvent
  | undefined = (event) => {
  if (event.type === "storage.changed") return parseDriveChanged(event);
  if (event.type === "storage.teamspaces") return { type: "storage.teamspaces" };
  const { type, nodeId } = event;
  if (!isId(nodeId) || !isNodeEventType(type)) return undefined;
  return NODE_EVENT_PARSERS[type](nodeId, event);
};

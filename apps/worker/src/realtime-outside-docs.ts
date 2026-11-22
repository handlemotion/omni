import { storageLiveRecordSchema, type StorageDocEvent } from "@omni/contracts";
import { applyUpdate, Doc } from "yjs";
import { createLogger } from "./log.ts";
import { docStream, type DocAppendMessage, type DocPresenceMessage } from "./realtime-docs.ts";
import { editingOf, insiders, type Editing } from "./realtime-files.ts";
import { noteOwed, takeBytes } from "./realtime-folds.ts";
import {
  noteEdited,
  OUTSIDE_CHECK_MS,
  outsideOf,
  recheckOutsider,
  sendToOutsiders,
} from "./realtime-outside.ts";
import { relayPresence, sendPresence } from "./realtime-presence.ts";
import { s2Basin, type S2Basin } from "./s2.ts";
import { loadConfig } from "./env.ts";

type Refusal = Extract<StorageDocEvent, { type: "doc.refused" }>["reason"];

const RATES = { append: [30, 60], presence: [10, 20] } as const;
const REFUSALS_TO_CLOSE = 50;

class Bucket {
  private tokens: number;
  private at = Date.now();
  private readonly rate: number;
  private readonly burst: number;
  constructor(rate: number, burst: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Limits {
  append: Bucket;
  presence: Bucket;
  refused: number[];
}

const limits = new WeakMap<WebSocket, Limits>();
const limitsOf = (socket: WebSocket) => {
  let found = limits.get(socket);
  if (!found) {
    found = {
      append: new Bucket(...RATES.append),
      presence: new Bucket(...RATES.presence),
      refused: [],
    };
    limits.set(socket, found);
  }
  return found;
};

const epochs = new Map<string, number>();

function wellFormed(u: string) {
  try {
    const doc = new Doc();
    applyUpdate(
      doc,
      Uint8Array.from(atob(u), (c) => c.charCodeAt(0)),
    );
    doc.destroy();
    return true;
  } catch {
    return false;
  }
}

function epochOf(body: string, seqNum: number) {
  try {
    const parsed = storageLiveRecordSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return -1;
    const record = parsed.data;
    return record.t === "seed" ? seqNum : record.t === "snap" ? record.e : -1;
  } catch {
    return -1;
  }
}

async function currentEpoch(basin: S2Basin, nodeId: string, fresh: boolean) {
  const known = epochs.get(nodeId);
  if (!fresh && known !== undefined) return known;
  let epoch = -1;
  for (const { seqNum, body } of await basin.readTail(docStream(nodeId), 1000)) {
    epoch = Math.max(epoch, epochOf(body, seqNum));
  }
  for (let at = 0, scan = epoch < 0; scan;) {
    const page = await basin.read(docStream(nodeId), at);
    for (const { seqNum, body } of page.records) epoch = Math.max(epoch, epochOf(body, seqNum));
    const last = page.records.at(-1);
    scan = page.more && !!last;
    at = (last?.seqNum ?? at) + 1;
  }
  epochs.set(nodeId, epoch);
  return epoch;
}

const send = (socket: WebSocket, event: StorageDocEvent) => {
  try {
    socket.send(JSON.stringify(event));
  } catch {}
};

function refuse(socket: WebSocket, nodeId: string, ref: number, reason: Refusal) {
  send(socket, { type: "doc.refused", nodeId, ref, reason });
  const counted = limitsOf(socket);
  const now = Date.now();
  counted.refused = counted.refused.filter((at) => now - at < 60_000);
  counted.refused.push(now);
  if (counted.refused.length >= REFUSALS_TO_CLOSE) {
    try {
      socket.close(4429, "too many refused messages");
    } catch {}
  }
}

async function fresh(env: Env, socket: WebSocket) {
  const at = editingOf(socket);
  if (at && Date.now() - (at.checkedAt ?? 0) <= OUTSIDE_CHECK_MS) return true;
  return recheckOutsider(env, socket);
}

async function appendFor(
  ctx: DurableObjectState,
  socket: WebSocket,
  basin: S2Basin,
  message: DocAppendMessage,
) {
  const { nodeId, ref } = message;
  const body = JSON.stringify(message.record);
  if (!(await takeBytes(ctx, nodeId, body.length))) {
    refuse(socket, nodeId, ref, "rate");
    return null;
  }
  let seqNum: number | null;
  try {
    seqNum = await basin.append(docStream(nodeId), body, message.matchSeqNum);
  } catch (error) {
    createLogger({ component: "realtime" }).error("doc.append_failed", { error, nodeId });
    refuse(socket, nodeId, ref, "unavailable");
    return null;
  }
  if (seqNum === null) refuse(socket, nodeId, ref, "tail");
  else send(socket, { type: "doc.appended", nodeId, ref, seqNum });
  return seqNum;
}

function passOn(ctx: DurableObjectState, socket: WebSocket, at: Editing, event: StorageDocEvent) {
  const forMembers = JSON.stringify(event);
  for (const other of insiders(ctx)) {
    if (editingOf(other)?.nodeId !== at.nodeId) continue;
    try {
      other.send(forMembers);
    } catch {}
  }
  sendToOutsiders(ctx, at.nodeId, [event], socket);
}

/**
 * An outsider's record (`docs/spec/live-sharing.md`): only an `update` of the doc it edits, from
 * an Editor whose door still opens, within its limits. Stamped with who sent it, passed on to
 * everyone on the doc, and owed a save by the Worker.
 */
export async function onOutsideAppend(
  ctx: DurableObjectState,
  env: Env,
  socket: WebSocket,
  message: DocAppendMessage,
) {
  const { nodeId, ref, record } = message;
  if (editingOf(socket)?.nodeId !== nodeId) return;
  if (!limitsOf(socket).append.take()) return refuse(socket, nodeId, ref, "rate");
  if (record.t !== "update" || record.n !== undefined) {
    return refuse(socket, nodeId, ref, "read_only");
  }
  if (!wellFormed(record.u)) return refuse(socket, nodeId, ref, "read_only");
  const basin = s2Basin(loadConfig(env));
  if (!basin) return refuse(socket, nodeId, ref, "unavailable");
  if (!(await fresh(env, socket))) return;
  const at = editingOf(socket);
  const outside = outsideOf(socket);
  if (!at || !outside) return;
  if (outside.role !== "editor" || !outside.writable) {
    return refuse(socket, nodeId, ref, "read_only");
  }
  if (at.locked) return refuse(socket, nodeId, ref, "locked");
  const epoch = await currentEpoch(basin, nodeId, false);
  if (record.e !== epoch && record.e !== (await currentEpoch(basin, nodeId, true))) {
    return refuse(socket, nodeId, ref, "tail");
  }
  const stamped = { t: "update" as const, e: record.e, u: record.u, by: outside.by };
  const seqNum = await appendFor(ctx, socket, basin, { ...message, record: stamped });
  if (seqNum === null) return;
  passOn(ctx, socket, at, { type: "doc.record", nodeId, seqNum, record: stamped });
  const id = outside.guestId ?? outside.userId ?? "";
  const kind = outside.door === "grant" ? "grantee" : "guest";
  await noteOwed(ctx, {
    nodeId,
    orgId: outside.orgId,
    by: outside.by,
    author: { kind, id, name: outside.user.name, lastSeq: seqNum },
  });
  await noteEdited(env, socket, nodeId);
}

/** An outsider's cursor: passed on stamped with who they are, from a door that still opens. */
export async function onOutsidePresence(
  ctx: DurableObjectState,
  env: Env,
  socket: WebSocket,
  message: DocPresenceMessage,
) {
  if (editingOf(socket)?.nodeId !== message.nodeId) return;
  if (!limitsOf(socket).presence.take()) return;
  if (!(await fresh(env, socket))) return;
  const relayed = relayPresence(ctx, socket, {
    nodeId: message.nodeId,
    u: message.u,
    memberId: null,
  });
  if (relayed) sendPresence(ctx, socket, message.nodeId, relayed);
}

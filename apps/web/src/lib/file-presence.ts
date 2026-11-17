import type { RealtimeEvent } from "./types.ts";

type FilePresenceEvent = Extract<RealtimeEvent, { type: "file.presence" }>;

export interface FileEditor {
  memberId: string;
  /** The workspace whose socket reported it, so a drop there clears only its entries. */
  orgId: string;
  /** When the last event for this member arrived (ms since epoch). */
  at: number;
}

/** The contract's expiry: anyone not heard from in 90 s. The editor repeats every 30 s. */
export const FILE_TTL_MS = 90_000;
export const FILE_REPEAT_MS = 30_000;

const EMPTY: readonly FileEditor[] = [];
let byNode = new Map<string, readonly FileEditor[]>();
const listeners = new Set<() => void>();
let sweep: ReturnType<typeof setTimeout> | undefined;

function emit() {
  for (const listener of listeners) listener();
  schedule();
}

function schedule() {
  clearTimeout(sweep);
  const oldest = Math.min(...[...byNode.values()].flat().map((p) => p.at));
  if (Number.isFinite(oldest)) {
    sweep = setTimeout(expire, Math.max(0, oldest + FILE_TTL_MS - Date.now()) + 50);
  }
}

function replace(keep: (editor: FileEditor) => boolean) {
  const next = new Map<string, readonly FileEditor[]>();
  let changed = false;
  for (const [nodeId, list] of byNode) {
    const kept = list.filter(keep);
    if (kept.length !== list.length) changed = true;
    if (kept.length) next.set(nodeId, kept);
  }
  if (!changed) return false;
  byNode = next;
  emit();
  return true;
}

function expire() {
  const now = Date.now();
  if (!replace((editor) => now - editor.at < FILE_TTL_MS)) schedule();
}

export const filePresenceStore = {
  get: (nodeId: string) => byNode.get(nodeId) ?? EMPTY,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function applyFilePresence(orgId: string, event: FilePresenceEvent) {
  const others = (byNode.get(event.nodeId) ?? EMPTY).filter((p) => p.memberId !== event.memberId);
  const list =
    event.state === "left"
      ? others
      : [...others, { memberId: event.memberId, orgId, at: Date.now() }];
  byNode = new Map(byNode);
  if (list.length) byNode.set(event.nodeId, list);
  else byNode.delete(event.nodeId);
  emit();
}

/** Forgets everyone a workspace's socket reported (every workspace without `orgId`). */
export function clearFilePresence(orgId?: string) {
  replace((editor) => !!orgId && editor.orgId !== orgId);
}

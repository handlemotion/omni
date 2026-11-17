import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { threadQuery } from "../lib/mail-queries.ts";
import { outstandingSends } from "../lib/pending.ts";
import {
  onThreadsMerged,
  RECHECK_SENDS_FAST_MS,
  RECHECK_SENDS_SLOW_MS,
  realtimeStatus,
  recheckOutstanding,
  recheckPendingSends,
  SEND_SOCKET_MS,
  startRealtime,
  trackSends,
  type RealtimeConnections,
} from "../lib/realtime.ts";

/**
 * Keeps the realtime socket for `orgId`, the active workspace, open while mounted. The lists show
 * only the active workspace's mail (ADR 0014, amended: workspace isolation), so that is the one
 * socket that always stays open. Another workspace's opens only while (a) a thread of it is on
 * screen (a link opens it as that workspace's member) or (b) for `SEND_SOCKET_MS` after a send
 * from one of its addresses, and closes once neither holds, so the member is offline there again
 * and gets its push. A send's result is tracked apart from the socket, over HTTP, until it
 * comes. A new `memberId` or org reopens the active one.
 */
export function useRealtimeConnection(orgId: string, options: { memberId?: string } = {}) {
  const client = useQueryClient();
  const { threadId } = useParams({ strict: false }) as { threadId?: string };
  const threadOrg = useQuery({
    ...threadQuery(threadId ?? ""),
    enabled: !!threadId,
    select: (thread) => thread.orgId,
  }).data;
  const sending = useSyncExternalStore(
    outstandingSends.subscribe,
    outstandingSends.get,
    outstandingSends.get,
  );
  const [now, setNow] = useState(() => Date.now());
  const fresh = sending.filter((s) => now - s.since < SEND_SOCKET_MS).map((s) => s.orgId);
  const others = [...new Set([threadId ? threadOrg : undefined, ...fresh])]
    .filter((id): id is string => !!id && id !== orgId)
    .sort()
    .join(",");

  const connections = useRef<RealtimeConnections | null>(null);
  const followed = useRef(others);
  useEffect(() => trackSends(client), [client]);
  useEffect(() => {
    const opened = startRealtime(client, orgId);
    connections.current = opened;
    opened.follow(followed.current ? followed.current.split(",") : []);
    return () => {
      opened.stop();
      connections.current = null;
    };
  }, [client, orgId, options.memberId]);
  useEffect(() => {
    followed.current = others;
    connections.current?.follow(others ? others.split(",") : []);
  }, [others]);
  const waiting = sending.length > 0;
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      void recheckOutstanding(client);
      const young = outstandingSends.get().some((s) => at - s.since < SEND_SOCKET_MS);
      timer = setTimeout(tick, young ? RECHECK_SENDS_FAST_MS : RECHECK_SENDS_SLOW_MS);
    };
    timer = setTimeout(tick, RECHECK_SENDS_FAST_MS);
    return () => clearTimeout(timer);
  }, [client, waiting]);
  useEffect(() => {
    if (threadId) void recheckPendingSends(client, threadId);
  }, [client, threadId]);
}

/** `connecting`, `open` or `closed`: for a "reconnecting…" indicator. */
export function useRealtimeStatus() {
  return useSyncExternalStore(realtimeStatus.subscribe, realtimeStatus.get, realtimeStatus.get);
}

/**
 * Calls `follow(intoThreadId)` when the thread `threadId` is merged into another (its messages
 * and helpdesk state moved there), so a reader showing it can move to the survivor.
 */
export function useFollowMerge(threadId: string, follow: (intoThreadId: string) => void) {
  const latest = useRef(follow);
  latest.current = follow;
  useEffect(
    () =>
      onThreadsMerged((event) => {
        if (event.fromThreadIds.includes(threadId)) latest.current(event.intoThreadId);
      }),
    [threadId],
  );
}
